/**
 * TDD tests: Coordinator Abort/ESC Signal Propagation
 *
 * Tests that AbortSignal from pi's tool layer correctly:
 * - Cancels the adapter
 * - Disposes resources
 * - Emits error progress
 * - Does not leak listeners
 */
import { describe, it, expect, vi, beforeEach, mock } from "bun:test";
import { AgentCoordinator, type AcpDelegateProgress } from "../src/coordination/coordinator.js";
import type { AcpConfig } from "../src/config/types.js";
import { createAdapter } from "../src/adapter-factory.js";

mock.module("../src/adapter-factory.js", () => ({
	createAdapter: vi.fn(),
	isKnownAdapter: vi.fn(),
}));

/**
 * Create a mock adapter where cancel() rejects any hanging in-flight promise.
 * This mirrors real behavior: cancel() aborts the pending ACP operation.
 */
function createMockAdapter(overrides: Record<string, any> = {}) {
  let pendingReject: ((err: Error) => void) | null = null;

  const adapter: Record<string, any> = {
    spawn: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue("test-session"),
    prompt: vi.fn().mockResolvedValue({
      text: "result",
      stopReason: "end_turn",
      sessionId: "test-session",
    }),
    cancel: vi.fn().mockImplementation(() => {
      if (pendingReject) {
        pendingReject(new DOMException("Operation cancelled", "AbortError"));
        pendingReject = null;
      }
      return Promise.resolve();
    }),
    dispose: vi.fn(),
    connected: true,
    ...overrides,
  };

  return adapter;
}

/**
 * Create a mock adapter that hangs on a specified method, with cancel() rejecting it.
 */
function createHangingMockAdapter(hangMethod: "spawn" | "initialize" | "prompt") {
  let pendingReject: ((err: Error) => void) | null = null;

  const hangFn = () =>
    new Promise<any>((_resolve, reject) => {
      pendingReject = reject;
    });

  const adapter = createMockAdapter({
    [hangMethod]: vi.fn().mockImplementation(hangFn),
  });

  adapter.cancel = vi.fn().mockImplementation(() => {
    if (pendingReject) {
      pendingReject(new DOMException("Operation cancelled", "AbortError"));
      pendingReject = null;
    }
    return Promise.resolve();
  });

  return adapter;
}

const mockConfig: AcpConfig = {
  agent_servers: {
    gemini: { command: "gemini", args: ["--acp"] },
  },
  defaultAgent: "gemini",
};

// Get the mocked createAdapter reference
const mockedCreateAdapter = createAdapter as ReturnType<typeof vi.fn>;

describe("AgentCoordinator — AbortSignal propagation", () => {
  let coordinator: AgentCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    coordinator = new AgentCoordinator(mockConfig, "/tmp");
  });

  it("pre-aborted signal: throws AbortError and disposes adapter", async () => {
    const adapter = createMockAdapter();
    mockedCreateAdapter.mockReturnValue(adapter as any);

    const controller = new AbortController();
    controller.abort();

    try {
      await coordinator.delegate("gemini", "test", undefined, undefined, controller.signal);
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("AbortError");
    }

    expect(adapter.cancel).toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalled();
  });

  it("abort during prompt: cancels and disposes adapter", async () => {
    const controller = new AbortController();
    const adapter = createHangingMockAdapter("prompt");
    mockedCreateAdapter.mockReturnValue(adapter as any);

    const delegatePromise = coordinator.delegate(
      "gemini",
      "test",
      undefined,
      undefined,
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 30));

    controller.abort();

    await expect(delegatePromise).rejects.toThrow();

    expect(adapter.cancel).toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalled();
  });

  it("abort during spawn: cleans up, no leak", async () => {
    const controller = new AbortController();
    const adapter = createHangingMockAdapter("spawn");
    mockedCreateAdapter.mockReturnValue(adapter as any);

    const delegatePromise = coordinator.delegate(
      "gemini",
      "test",
      undefined,
      undefined,
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    await expect(delegatePromise).rejects.toThrow();

    expect(adapter.cancel).toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalled();
  });

  it("abort during initialize: cleans up, no leak", async () => {
    const controller = new AbortController();
    const adapter = createHangingMockAdapter("initialize");
    mockedCreateAdapter.mockReturnValue(adapter as any);

    const delegatePromise = coordinator.delegate(
      "gemini",
      "test",
      undefined,
      undefined,
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    await expect(delegatePromise).rejects.toThrow();

    expect(adapter.cancel).toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalled();
  });

  it("no signal = no abort: completes normally", async () => {
    const adapter = createMockAdapter();
    mockedCreateAdapter.mockReturnValue(adapter as any);

    const result = await coordinator.delegate("gemini", "test");

    expect(result.text).toBe("result");
    expect(result.stopReason).toBe("end_turn");
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it("progress callback receives error phase on abort", async () => {
    const controller = new AbortController();
    const progressCalls: AcpDelegateProgress[] = [];
    const onProgress = (p: AcpDelegateProgress) => progressCalls.push(p);

    const adapter = createHangingMockAdapter("prompt");
    mockedCreateAdapter.mockReturnValue(adapter as any);

    const delegatePromise = coordinator.delegate(
      "gemini",
      "test",
      undefined,
      onProgress,
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    try {
      await delegatePromise;
    } catch {}

    const errorPhases = progressCalls.filter((p) => p.phase === "error");
    expect(errorPhases.length).toBeGreaterThanOrEqual(1);
    expect(errorPhases[0].agentName).toBe("gemini");
  });
});

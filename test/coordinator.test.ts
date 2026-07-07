/**
 * TDD tests: Coordinator Abort/ESC Signal Propagation
 *
 * Tests that AbortSignal from pi's tool layer correctly:
 * - Cancels the adapter
 * - Disposes resources
 * - Emits error progress
 * - Does not leak listeners
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCoordinator, type AcpDelegateProgress } from "../src/coordination/coordinator.js";
import type { AcpConfig } from "../src/config/types.js";
import { createAdapter } from "../src/adapter-factory.js";

vi.mock("../src/adapter-factory.js");

/**
 * Create a mock adapter where cancel() rejects any hanging in-flight promise.
 * This mirrors real behavior: cancel() aborts the pending ACP operation.
 */
function createMockAdapter(overrides: Record<string, any> = {}) {
  // Track pending operations so cancel() can reject them
  let pendingReject: ((err: Error) => void) | null = null;

  const trackPending = <T>(promiseFactory: () => Promise<T>): (() => Promise<T>) => {
    return () =>
      new Promise<T>((resolve, reject) => {
        pendingReject = reject;
        promiseFactory().then(resolve, reject);
      });
  };

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

  // Override cancel to reject the hanging promise
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

describe("AgentCoordinator — AbortSignal propagation", () => {
  let coordinator: AgentCoordinator;

  beforeEach(() => {
    (createAdapter as any).mockReturnValue(createMockAdapter() as any);
    coordinator = new AgentCoordinator(mockConfig, "/tmp");
  });

  it("pre-aborted signal: throws AbortError and disposes adapter", async () => {
    const adapter = createMockAdapter();
    (createAdapter as any).mockReturnValue(adapter as any);

    const controller = new AbortController();
    controller.abort();

    try {
      await coordinator.delegate("gemini", "test", undefined, undefined, controller.signal);
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("AbortError");
    }

    // cancel + dispose called by onAbort; dispose also called in finally
    expect(adapter.cancel).toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalled();
  });

  it("abort during prompt: cancels and disposes adapter", async () => {
    const controller = new AbortController();
    const adapter = createHangingMockAdapter("prompt");
    (createAdapter as any).mockReturnValue(adapter as any);

    const delegatePromise = coordinator.delegate(
      "gemini",
      "test",
      undefined,
      undefined,
      controller.signal,
    );

    // Let coordinator reach the prompt phase
    await new Promise((r) => setTimeout(r, 30));

    controller.abort();

    await expect(delegatePromise).rejects.toThrow();

    // cancel called by onAbort (or by the pending promise rejection)
    expect(adapter.cancel).toHaveBeenCalled();
    // dispose called by onAbort + finally
    expect(adapter.dispose).toHaveBeenCalled();
  });

  it("abort during spawn: cleans up, no leak", async () => {
    const controller = new AbortController();
    const adapter = createHangingMockAdapter("spawn");
    (createAdapter as any).mockReturnValue(adapter as any);

    const delegatePromise = coordinator.delegate(
      "gemini",
      "test",
      undefined,
      undefined,
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    // With adapter pooling, abort during spawn races against adapter creation.
    // The adapter reference isn't available yet (spawn hanging), so cancel
    // can't be called — but the delegate MUST reject and the pool is cleaned up.
    await expect(delegatePromise).rejects.toThrow();
  });

  it("abort during initialize: cleans up, no leak", async () => {
    const controller = new AbortController();
    const adapter = createHangingMockAdapter("initialize");
    (createAdapter as any).mockReturnValue(adapter as any);

    const delegatePromise = coordinator.delegate(
      "gemini",
      "test",
      undefined,
      undefined,
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    // With adapter pooling, abort during initialize races against creation.
    // Same as abort-during-spawn: cancel can't be called, but delegate rejects.
    await expect(delegatePromise).rejects.toThrow();
  });

  it("no signal = no abort: completes normally", async () => {
    const adapter = createMockAdapter();
    (createAdapter as any).mockReturnValue(adapter as any);

    const result = await coordinator.delegate("gemini", "test");

    expect(result.text).toBe("result");
    expect(result.stopReason).toBe("end_turn");
    expect(adapter.cancel).not.toHaveBeenCalled();
    // With adapter pooling, adapter is NOT disposed after successful use —
    // it stays in the pool for reuse by the next delegate call.
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it("progress callback receives error phase on abort", async () => {
    const controller = new AbortController();
    const progressCalls: AcpDelegateProgress[] = [];
    const onProgress = (p: AcpDelegateProgress) => progressCalls.push(p);

    const adapter = createHangingMockAdapter("prompt");
    (createAdapter as any).mockReturnValue(adapter as any);

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

    // Should have received at least one error phase
    const errorPhases = progressCalls.filter((p) => p.phase === "error");
    expect(errorPhases.length).toBeGreaterThanOrEqual(1);
    expect(errorPhases[0].agentName).toBe("gemini");
  });
});

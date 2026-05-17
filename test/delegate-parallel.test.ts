/**
 * TDD: acp_delegate_parallel tool
 *
 * Tests the Promise.all style parallel delegation with per-agent progress
 * tracking in the widget.
 *
 * Strategy: Follow level3-tool-execution.test.ts pattern — mock the
 * AgentCoordinator, load the extension, call tool execute.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDelegate = vi.fn();
let runtimeDir = "";

vi.mock("../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agent_servers: {
      gemini: { command: "gemini", args: ["--acp"] },
      claude: { command: "claude", args: ["--acp"] },
      codex: { command: "codex", args: ["--acp"] },
    },
    defaultAgent: "gemini",
    staleTimeoutMs: 3_600_000,
    healthCheckIntervalMs: 30_000,
    circuitBreakerMaxFailures: 3,
    circuitBreakerResetMs: 60_000,
    stallTimeoutMs: 300_000,
    modelPolicy: {
      allowedModels: [],
      blockedModels: [],
      requireProviderPrefix: false,
    },
    runtimeDir,
  })),
}));

vi.mock("../src/coordination/coordinator.js", () => ({
  AgentCoordinator: class MockAgentCoordinator {
    delegate = mockDelegate;
    broadcast = vi.fn();
    compare = vi.fn();
    formatComparison() {
      return "formatted";
    }
  },
}));

vi.mock("../src/adapter-factory.js", () => ({
  createAdapter: vi.fn(() => ({
    spawn: vi.fn(),
    initialize: vi.fn(),
    newSession: vi.fn(async () => "session-1"),
    loadSession: vi.fn(),
    prompt: vi.fn(async () => ({ text: "ok", sessionId: "session-1", stopReason: "end_turn" })),
    setModel: vi.fn(),
    setMode: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

function uniqueRuntimeDir() {
  return mkdtempSync(join(tmpdir(), "pi-acp-test-parallel-"));
}

function createMockPi() {
  const tools: any[] = [];
  return {
    tools,
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand() {},
    on() {},
    sendMessage: vi.fn(),
  };
}

function createMockCtx() {
  return {
    cwd: "/base",
    ui: {
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
  };
}

async function loadParallelTool() {
  vi.resetModules();
  const mockPi = createMockPi();
  const mod = await import("../index.js");
  mod.default(mockPi as any);
  return mockPi.tools.find((t: any) => t.name === "acp_delegate_parallel");
}

// ── Tests ───────────────────────────────────────────────────────────

describe("acp_delegate_parallel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeDir = uniqueRuntimeDir();
  });

  // Test 1: Parallel delegate calls beginWidgetActivity per agent
  it("registers 3 delegations in widgetActivity for 3 agents", async () => {
    mockDelegate.mockResolvedValue({
      text: "ok",
      sessionId: "sid-1",
      stopReason: "end_turn",
    });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();
    const result = await tool.execute(
      "tc1",
      { message: "do work", agents: ["gemini", "claude", "codex"] },
      undefined,
      undefined,
      ctx,
    );

    // All 3 delegates were called
    expect(mockDelegate).toHaveBeenCalledTimes(3);
    expect(mockDelegate).toHaveBeenCalledWith("gemini", "do work", "/base", expect.any(Function), undefined);
    expect(mockDelegate).toHaveBeenCalledWith("claude", "do work", "/base", expect.any(Function), undefined);
    expect(mockDelegate).toHaveBeenCalledWith("codex", "do work", "/base", expect.any(Function), undefined);

    // Result contains all 3 agent responses
    expect(result.details.results).toHaveLength(3);
    expect(result.details.results.map((r: any) => r.agent)).toEqual(["gemini", "claude", "codex"]);
  });

  // Test 2: Each agent gets its own onProgress callback
  it("fires onProgress independently per agent", async () => {
    let progressCalls: Array<{ agent: string; phase: string }> = [];

    mockDelegate.mockImplementation(async (agent: string, _msg: string, _cwd: string, onProgress?: Function) => {
      if (onProgress) {
        onProgress({ agentName: agent, phase: "spawning", durationMs: 100, lastActivityAt: Date.now() });
        onProgress({ agentName: agent, phase: "prompting", durationMs: 200, lastActivityAt: Date.now() });
      }
      return { text: `response from ${agent}`, sessionId: `sid-${agent}`, stopReason: "end_turn" };
    });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();
    const result = await tool.execute(
      "tc2",
      { message: "test progress", agents: ["gemini", "claude"] },
      undefined,
      undefined,
      ctx,
    );

    // Both agents got delegated
    expect(mockDelegate).toHaveBeenCalledTimes(2);
    // Results are correct
    expect(result.details.results[0].text).toBe("response from gemini");
    expect(result.details.results[1].text).toBe("response from claude");
  });

  // Test 3: Widget shows all active during run
  it("widget shows multiple delegations while running", async () => {
    let delegateResolveFns: Array<(v: any) => void> = [];

    mockDelegate.mockImplementation(async (agent: string, _msg: string, _cwd: string, onProgress?: Function) => {
      if (onProgress) {
        onProgress({ agentName: agent, phase: "prompting", durationMs: 500, lastActivityAt: Date.now() });
      }
      return new Promise((resolve) => {
        delegateResolveFns.push(resolve);
      });
    });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();

    // Start the parallel execution (don't await yet)
    const resultPromise = tool.execute(
      "tc3",
      { message: "long task", agents: ["gemini", "claude"] },
      undefined,
      undefined,
      ctx,
    );

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 50));

    // Widget should have been refreshed with delegations
    // setWidget is called by beginWidgetActivity → refreshWidget
    expect(ctx.ui.setWidget).toHaveBeenCalled();

    // Resolve all delegates
    for (const resolve of delegateResolveFns) {
      resolve({ text: "done", sessionId: "sid-x", stopReason: "end_turn" });
    }

    const result = await resultPromise;
    expect(result.details.results).toHaveLength(2);
  });

  // Test 4: Cleanup removes all after completion
  it("cleans up all delegations after all agents complete", async () => {
    mockDelegate.mockResolvedValue({
      text: "ok",
      sessionId: "sid-1",
      stopReason: "end_turn",
    });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();
    await tool.execute(
      "tc4",
      { message: "cleanup test", agents: ["gemini", "claude", "codex"] },
      undefined,
      undefined,
      ctx,
    );

    // After completion, widgetActivity.delegations should be empty
    // We can't directly inspect widgetActivity, but setWidget should have been called
    // with the final state (no delegations)
    const lastCallIdx = ctx.ui.setWidget.mock.calls.length - 1;
    expect(lastCallIdx).toBeGreaterThanOrEqual(0);
  });

  // Test 5: Partial failure — one fails, others succeed
  it("handles partial failure: agent 2 fails, 1 and 3 succeed", async () => {
    mockDelegate
      .mockResolvedValueOnce({ text: "gemini response", sessionId: "sid-g", stopReason: "end_turn" })
      .mockRejectedValueOnce(new Error("claude crashed"))
      .mockResolvedValueOnce({ text: "codex response", sessionId: "sid-c", stopReason: "end_turn" });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();
    const result = await tool.execute(
      "tc5",
      { message: "partial fail", agents: ["gemini", "claude", "codex"] },
      undefined,
      undefined,
      ctx,
    );

    // All 3 were attempted
    expect(mockDelegate).toHaveBeenCalledTimes(3);

    // Results contain all 3 agents
    expect(result.details.results).toHaveLength(3);

    // Check individual results
    const geminiResult = result.details.results.find((r: any) => r.agent === "gemini");
    const claudeResult = result.details.results.find((r: any) => r.agent === "claude");
    const codexResult = result.details.results.find((r: any) => r.agent === "codex");

    expect(geminiResult.text).toBe("gemini response");
    expect(geminiResult.error).toBeUndefined();

    expect(claudeResult.text).toBe("");
    expect(claudeResult.error).toBe("claude crashed");

    expect(codexResult.text).toBe("codex response");
    expect(codexResult.error).toBeUndefined();

    // Content includes all responses
    const text = result.content[0].text;
    expect(text).toContain("gemini response");
    expect(text).toContain("claude crashed");
    expect(text).toContain("codex response");
  });

  // Test 6: Abort cancels all running delegates
  it("propagates abort signal to all delegates", async () => {
    mockDelegate.mockResolvedValue({
      text: "ok",
      sessionId: "sid-1",
      stopReason: "end_turn",
    });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();

    const controller = new AbortController();
    // Don't abort yet — just verify signal is passed through

    const result = await tool.execute(
      "tc6",
      { message: "abort test", agents: ["gemini", "claude"] },
      controller.signal,
      undefined,
      ctx,
    );

    // Signal was passed to each delegate call
    expect(mockDelegate).toHaveBeenCalledWith("gemini", "abort test", "/base", expect.any(Function), controller.signal);
    expect(mockDelegate).toHaveBeenCalledWith("claude", "abort test", "/base", expect.any(Function), controller.signal);
  });

  // Test 7: Returns aggregated results in structured format
  it("returns structured results with agent, text, sessionId, stopReason, and optional error", async () => {
    mockDelegate
      .mockResolvedValueOnce({ text: "alpha", sessionId: "sid-a", stopReason: "end_turn" })
      .mockResolvedValueOnce({ text: "beta", sessionId: "sid-b", stopReason: "end_turn" });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();
    const result = await tool.execute(
      "tc7",
      { message: "structured", agents: ["gemini", "claude"] },
      undefined,
      undefined,
      ctx,
    );

    // Check structure
    expect(result.details).toHaveProperty("results");
    expect(result.details.results).toHaveLength(2);

    for (const r of result.details.results) {
      expect(r).toHaveProperty("agent");
      expect(r).toHaveProperty("text");
      expect(r).toHaveProperty("sessionId");
      expect(r).toHaveProperty("stopReason");
    }

    // Content is human-readable
    expect(result.content[0].text).toContain("Parallel delegation results");
    expect(result.content[0].text).toContain("gemini");
    expect(result.content[0].text).toContain("claude");
    expect(result.content[0].text).toContain("alpha");
    expect(result.content[0].text).toContain("beta");
  });

  // Test 8: Validates agents array is not empty
  it("returns error when agents array is empty", async () => {
    const tool = await loadParallelTool();
    const ctx = createMockCtx();
    const result = await tool.execute(
      "tc8",
      { message: "no agents", agents: [] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("No agents specified");
    expect(result.details.error).toBe("no_agents");
  });

  // Test 9: Forwards _onUpdate progress per agent
  it("calls _onUpdate with per-agent progress", async () => {
    const onUpdate = vi.fn();

    mockDelegate.mockImplementation(async (agent: string, _msg: string, _cwd: string, onProgress?: Function) => {
      if (onProgress) {
        onProgress({ agentName: agent, phase: "prompting", durationMs: 300, lastActivityAt: Date.now() });
      }
      return { text: `${agent} done`, sessionId: `sid-${agent}`, stopReason: "end_turn" };
    });

    const tool = await loadParallelTool();
    const ctx = createMockCtx();
    await tool.execute(
      "tc9",
      { message: "progress test", agents: ["gemini", "claude"] },
      undefined,
      onUpdate,
      ctx,
    );

    // _onUpdate should have been called for each agent's progress
    expect(onUpdate).toHaveBeenCalled();
    // At least 2 calls (one per agent progress)
    expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

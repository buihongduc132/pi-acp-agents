import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



const nameStoreMock = vi.hoisted(() => ({ instance: undefined as any }));
vi.mock("../src/management/session-name-store.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/management/session-name-store.js")>();
  return {
    ...orig,
    SessionNameStore: class {
      getSessionId = vi.fn();
      getName = vi.fn();
      register = vi.fn((n: string, id: string) => ({ sessionName: n, sessionId: id }));
      release = vi.fn();
      constructor() { nameStoreMock.instance = this; }
    },
  };
});

vi.mock("../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agent_servers: { quick_task: { command: "pi-acp" } },
    defaultAgent: "quick_task",
    runtimeDir: undefined,
    staleTimeoutMs: undefined,
    circuitBreakerMaxFailures: undefined,
    circuitBreakerResetMs: undefined,
  })),
  validateConfig: vi.fn((c: any) => c),
  resolveConfigPath: vi.fn(() => "/tmp/test-config.json"),
}));

vi.mock("../src/core/session-manager.js", () => ({
  SessionManager: vi.fn(function () {
    const live = [{ sessionId: "s-live-1", sessionName: "r9-clean-me", agentName: "quick_task", cwd: "/tmp" }];
    return {
      add: vi.fn(), get: vi.fn(),
      list: vi.fn(() => live),
      listByAgent: vi.fn(() => []),
      remove: vi.fn(async (id: string) => { live.splice(live.findIndex((s) => s.sessionId === id), 1); }),
      disposeAll: vi.fn(), size: live.length,
    };
  }),
}));

vi.mock("../src/management/task-store.js", () => ({
  AcpTaskStore: vi.fn(function () { return {
    create: vi.fn(), get: vi.fn(), update: vi.fn(),
    updateWhere: vi.fn(() => []), list: vi.fn(() => []),
    clear: vi.fn(() => ({ removed: 0, remaining: 0 })),
  }; }),
}));

vi.mock("../src/management/mailbox-manager.js", () => ({
  MailboxManager: vi.fn(function () { return {
    send: vi.fn(), listFor: vi.fn(() => []),
    listAll: vi.fn(() => []), markRead: vi.fn(), clearFor: vi.fn(() => 0),
  }; }),
}));

vi.mock("../src/management/governance-store.js", () => ({
  GovernanceStore: vi.fn(function () { return {
    getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(),
    getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
    setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true })),
  }; }),
}));

vi.mock("../src/core/event-log.js", () => ({ AcpEventLog: vi.fn(() => ({ append: vi.fn() })) }));
vi.mock("../src/core/circuit-breaker.js", () => ({
  AcpCircuitBreaker: vi.fn(function () { return { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" }; }),
}));
vi.mock("../src/core/health-monitor.js", () => ({
  HealthMonitor: vi.fn(function () { return {
    start: vi.fn(), stop: vi.fn(), register: vi.fn(),
    touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn(),
  }; }),
}));
vi.mock("../src/adapter-factory.js", () => ({
  createAdapter: vi.fn(() => ({
    spawn: vi.fn(), initialize: vi.fn(),
    newSession: vi.fn(async () => "s1"),
    loadSession: vi.fn(async (id?: string) => id ?? "s1"),
    prompt: vi.fn(async () => ({ text: "ok", stopReason: "end_turn", sessionId: "s1" })),
    setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
  })),
}));
vi.mock("../src/coordination/agent-coordinator.js", () => ({
  AgentCoordinator: vi.fn(function () { return { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn() }; }),
}));

function createMockPi() {
  const tools: any[] = [];
  return {
    tools,
    registerTool: vi.fn((tool: any) => tools.push(tool)),
    registerCommand: vi.fn(),
    on: vi.fn(),
  };
}

describe("R9 — acp_status cleanup purges session-name registry", () => {
  beforeEach(() => { vi.resetModules(); });

  it("cleanup sessions releases registry entries for every removed session", async () => {
    const mockPi = createMockPi();
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    const statusTool = mockPi.tools.find((t: any) => t.name === "acp_status");
    const result = await statusTool.execute(
      "tc1",
      { action: "cleanup", target: "sessions" },
      undefined,
      undefined,
      { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } },
    );
    expect(result.details.removedSessions).toContain("s-live-1");
    // Registry entries for removed sessions MUST be released, otherwise later
    // acp_msg reopens of a same-named fresh session collide with
    // "Session name ... is already assigned ...".
    expect(nameStoreMock.instance.release).toHaveBeenCalledWith("s-live-1");
  });
});

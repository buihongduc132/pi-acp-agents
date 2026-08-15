import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
vi.mock("../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agent_servers: { quick_task: { command: "pi-acp" } },
    defaultAgent: "quick_task",
    runtimeDir: undefined,
    staleTimeoutMs: undefined,
    circuitBreakerMaxFailures: undefined,
    circuitBreakerResetMs: undefined,
    spawns: { asyncDefault: false },
  })),
  validateConfig: vi.fn((c: any) => c),
  resolveConfigPath: vi.fn(() => "/tmp/test-config.json"),
}));

// Mock session manager
vi.mock("../src/core/session-manager.js", () => ({
  SessionManager: vi.fn(function () { return {
    add: vi.fn(), get: vi.fn(), list: vi.fn(() => []),
    listByAgent: vi.fn(() => []), remove: vi.fn(),
    disposeAll: vi.fn(), size: 0,
  }; }),
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

vi.mock("../src/core/event-log.js", () => ({
  AcpEventLog: vi.fn(() => ({ append: vi.fn() })),
}));

vi.mock("../src/core/circuit-breaker.js", () => ({
  AcpCircuitBreaker: vi.fn(function () { return {
    execute: vi.fn(async (fn: () => any) => fn()),
    state: "closed",
  }; }),
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
  AgentCoordinator: vi.fn(function () { return {
    delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn(),
  }; }),
}));

// Mock WorktreeManager
vi.mock("../src/core/worktree-manager.js", () => ({
  WorktreeManager: vi.fn(function () { return {
    create: vi.fn(() => "/tmp/wt-x"),
    remove: vi.fn(),
  }; }),
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

function createMockCtx() {
  return { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };
}

async function loadTools() {
  const mockPi = createMockPi();
  const mod = await import("../index.js");
  mod.default(mockPi as any);
  return {
    spawnTool: mockPi.tools.find((t: any) => t.name === "acp_spawn"),
  };
}

describe("B7 — acp_spawn worktree details", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sync spawn with worktree:true includes worktreePath in details", async () => {
    const { spawnTool } = await loadTools();
    const result = await spawnTool.execute(
      "tc1",
      { agent: "quick_task", worktree: true, async: false, idleTtlMs: 0, prompt: "hi" },
      undefined,
      undefined,
      createMockCtx(),
    );
    // The tool must return the created worktree path in details
    expect((result.details as any)?.worktreePath).toBe("/tmp/wt-x");
  });
});

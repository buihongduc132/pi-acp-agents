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
  })),
  validateConfig: vi.fn((c: any) => c),
  resolveConfigPath: vi.fn(() => "/tmp/test-config.json"),
  resolveAcpBaseDir: vi.fn(() => "/tmp/acp-test-base"),
}));

// Mock session manager
vi.mock("../src/core/session-manager.js", () => ({
  SessionManager: vi.fn(function () { return {
    add: vi.fn(), get: vi.fn(), list: vi.fn(() => []),
    listByAgent: vi.fn(() => []), remove: vi.fn(),
    disposeAll: vi.fn(), size: 0,
  }; }),
}));

// Task store: update returns null for "99999" (simulates not-found)
vi.mock("../src/management/task-store.js", () => ({
  AcpTaskStore: vi.fn(function () { return {
    create: vi.fn((i: any) => ({ id: "t1", subject: i.subject })),
    get: vi.fn(),
    update: vi.fn((id: string) => {
      if (id === "99999") return null; // not found
      return { id, subject: "mock", status: "pending" };
    }),
    updateWhere: vi.fn(() => []),
    list: vi.fn(() => []),
    clear: vi.fn(() => ({ removed: 0, remaining: 0 })),
  }; }),
}));

// Mailbox
vi.mock("../src/management/mailbox-manager.js", () => ({
  MailboxManager: vi.fn(function () { return {
    send: vi.fn(), listFor: vi.fn(() => []),
    listAll: vi.fn(() => []), markRead: vi.fn(), clearFor: vi.fn(() => 0),
  }; }),
}));

// Governance
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
    taskTool: mockPi.tools.find((t: any) => t.name === "acp_task"),
    statusTool: mockPi.tools.find((t: any) => t.name === "acp_status"),
    msgTool: mockPi.tools.find((t: any) => t.name === "acp_msg"),
  };
}

describe("B6 — error results carry explicit error signal", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("acp_task update with nonexistent task_id carries error signal", async () => {
    const { taskTool } = await loadTools();
    const result = await taskTool.execute("tc1", { action: "update", task_id: "99999", status: "completed" }, undefined, undefined, createMockCtx());
    // Must have explicit error signal: either details.error truthy OR isError true
    const hasErrorSignal = (result.details as any)?.error || result.isError === true;
    expect(hasErrorSignal).toBeTruthy();
  });

  it("acp_status interrupt with unknown run_id carries error signal", async () => {
    const { statusTool } = await loadTools();
    const result = await statusTool.execute("tc2", { action: "interrupt", id: "nonexistent-run" }, undefined, undefined, createMockCtx());
    // Must have explicit error signal
    const hasErrorSignal = (result.details as any)?.error || result.isError === true;
    expect(hasErrorSignal).toBeTruthy();
  });

  it("acp_msg send to nonexistent session carries error signal", async () => {
    const { msgTool } = await loadTools();
    const result = await msgTool.execute("tc3", { action: "send", session_id: "nonexistent-session-id", message: "hi" }, undefined, undefined, createMockCtx());
    // Must have explicit error signal
    const hasErrorSignal = (result.details as any)?.error || result.isError === true;
    expect(hasErrorSignal).toBeTruthy();
  });
});

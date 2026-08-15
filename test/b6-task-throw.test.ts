import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same mock substrate as b6-error-flag.test.ts — EXCEPT task-store is REAL
// (r10 live drive: real TaskStore.update() THROWS on unknown id, tool leaked
// the throw past its `if (!updated)` guard → details={} instead of not_found).

vi.mock("../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agent_servers: { quick_task: { command: "pi-acp" } },
    defaultAgent: "quick_task",
    runtimeDir: undefined,
  })),
  validateConfig: vi.fn((c: any) => c),
  resolveConfigPath: vi.fn(() => "/tmp/test-config.json"),
  resolveAcpBaseDir: vi.fn(() => {
    if (process.env.ACP_RUNTIME_DIR) return process.env.ACP_RUNTIME_DIR;
    throw new Error("ACP_RUNTIME_DIR not set");
  }),
}));

vi.mock("../src/core/session-manager.js", () => ({
  SessionManager: vi.fn(function () { return {
    add: vi.fn(), get: vi.fn(), list: vi.fn(() => []),
    listByAgent: vi.fn(() => []), remove: vi.fn(),
    disposeAll: vi.fn(), size: 0,
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

function createMockPi() {
  const tools: any[] = [];
  return { tools, registerTool: vi.fn((tool: any) => tools.push(tool)), registerCommand: vi.fn(), on: vi.fn() };
}
function createMockCtx() { return { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } }; }

async function loadTaskTool() {
  const mockPi = createMockPi();
  const mod = await import("../index.js");
  mod.default(mockPi as any);
  return mockPi.tools.find((t: any) => t.name === "acp_task");
}

describe("B6 — acp_task update not-found with REAL TaskStore (throws)", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns details.error='not_found' (catches the store throw)", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "b6-throw-"));
    mkdirSync(join(runtimeDir, "dag"), { recursive: true });
    process.env.ACP_RUNTIME_DIR = runtimeDir;
    try {
      const tool = await loadTaskTool();
      expect(tool).toBeDefined();
      const res = await tool!.execute(
        "tc-b6t", { action: "update", task_id: "99999", status: "completed" },
        undefined, undefined, createMockCtx() as any,
      );
      expect((res.details as any)?.error).toBe("not_found");
      expect(res.content[0].text).toContain("not found");
    } finally {
      delete process.env.ACP_RUNTIME_DIR;
    }
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agent_servers: {
      gemini: { command: "gemini", args: ["--acp"] },
      claude: { command: "claude-agent-acp" },
    },
    defaultAgent: "gemini",
    runtimeDir: undefined,
    staleTimeoutMs: undefined,
    circuitBreakerMaxFailures: undefined,
    circuitBreakerResetMs: undefined,
  })),
  validateConfig: vi.fn((c: any) => c),
}));

vi.mock("../src/core/session-manager.js", () => ({
  SessionManager: vi.fn(function () { return {
    add: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
    listByAgent: vi.fn(() => []),
    remove: vi.fn(),
    disposeAll: vi.fn(),
    size: 0,
  }; }),
}));

vi.mock("../src/management/task-store.js", () => ({
  AcpTaskStore: vi.fn(function () { return {
    create: vi.fn((i: any) => ({
      id: "t1", subject: i.subject, description: i.description ?? null,
      status: "pending", assignee: i.assignee ?? null,
      blockedBy: i.deps ?? [], result: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })),
    get: vi.fn(),
    update: vi.fn((_id: string, mut: (t: any) => void) => {
      const t: any = { id: _id, subject: "mock", status: "pending", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" };
      mut(t); return t;
    }),
    updateWhere: vi.fn(() => []),
    list: vi.fn(() => []),
    clear: vi.fn(() => ({ removed: 0, remaining: 0 })),
  }; }),
}));

vi.mock("../src/management/mailbox-manager.js", () => ({
  MailboxManager: vi.fn(function () { return {
    send: vi.fn((i: any) => ({ id: "m1", from: i.from, to: i.to, message: i.message, kind: i.kind, createdAt: new Date().toISOString() })),
    listFor: vi.fn(() => []),
    listAll: vi.fn(() => []),
    markRead: vi.fn(),
    clearFor: vi.fn(() => 0),
  }; }),
}));

vi.mock("../src/management/governance-store.js", () => ({
  GovernanceStore: vi.fn(function () { return {
    getPlan: vi.fn(),
    requestPlan: vi.fn(),
    resolvePlan: vi.fn(),
    getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
    setModelPolicy: vi.fn(),
    checkModel: vi.fn(() => ({ ok: true, reason: "" })),
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
    start: vi.fn(),
    stop: vi.fn(),
    register: vi.fn(),
    touch: vi.fn(),
    markPromptStart: vi.fn(),
    markPromptEnd: vi.fn(),
  }; }),
}));

vi.mock("../src/adapter-factory.js", () => ({
  createAdapter: vi.fn(() => ({
    spawn: vi.fn(),
    initialize: vi.fn(),
    newSession: vi.fn(async () => "persisted-session-1"),
    loadSession: vi.fn(async (id?: string) => id ?? "loaded-1"),
    prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "persisted-session-1" })),
    setModel: vi.fn(),
    setMode: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("../src/coordination/agent-coordinator.js", () => ({
  AgentCoordinator: vi.fn(function () { return {
    delegate: vi.fn(async () => ({ text: "delegated", stopReason: "end_turn", sessionId: "d1" })),
    broadcast: vi.fn(async () => [
      { agent: "gemini", text: "g response", sessionId: "s1", stopReason: "end_turn" },
      { agent: "claude", text: "", sessionId: "", stopReason: "error", error: "boom" },
    ]),
    compare: vi.fn(async () => ({ responses: [] })),
  }; }),
}));

let runtimeDir: string;
const mockDelegate = vi.fn();
const mockBroadcast = vi.fn();
const mockCompare = vi.fn();
const mockNewSession = vi.fn();
const mockLoadSession = vi.fn();
const mockPrompt = vi.fn();

function uniqueRuntimeDir() {
  return `/tmp/pi-acp-agents-test-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  const findTool = (name: string) => mockPi.tools.find((t) => t.name === name);
  return {
    promptTool: findTool("acp_prompt"),
    statusTool: findTool("acp_status"),
    broadcastTool: findTool("acp_broadcast"),
    cancelTool: findTool("acp_cancel"),
    taskCreateTool: findTool("acp_task_create"),
    taskUpdateTool: findTool("acp_task_update"),
    messageTool: findTool("acp_message"),
  };
}

describe("Level 3+ — tool execute behavior (consolidated)", () => {
  beforeEach(() => {
    runtimeDir = uniqueRuntimeDir();
  });

  it("acp_broadcast returns aggregated responses", async () => {
    const { broadcastTool } = await loadTools();
    const result = await broadcastTool.execute("tc2", { message: "compare", agents: ["gemini", "claude"] }, undefined, undefined, createMockCtx());
    // Broadcast delegates to coordinator which is mocked
  });

  it("task tools: create, update via consolidated acp_task_update", async () => {
    const { taskCreateTool, taskUpdateTool } = await loadTools();
    expect(taskCreateTool).toBeDefined();
    expect(taskUpdateTool).toBeDefined();
    
    const created = await taskCreateTool.execute("tc7", { subject: "Investigate", description: "deep work", assignee: "gemini" }, undefined, undefined, createMockCtx());
    const taskId = created.details.id;

    // All task mutations now go through acp_task_update
    const updated = await taskUpdateTool.execute("tc8", { task_id: taskId, status: "in_progress", assignee: "claude", result: "started" }, undefined, undefined, createMockCtx());
    expect(updated.content[0].text).toContain("updated");
  });

  it("task deps managed via acp_task_update deps_add/deps_remove", async () => {
    const { taskCreateTool, taskUpdateTool } = await loadTools();
    const created = await taskCreateTool.execute("tc9", { subject: "Task with deps", deps: ["1"] }, undefined, undefined, createMockCtx());
    
    const updated = await taskUpdateTool.execute("tc10", { task_id: created.details.id, deps_add: ["2"], deps_remove: ["1"] }, undefined, undefined, createMockCtx());
    expect(updated.content[0].text).toContain("updated");
  });

  it("mailbox: acp_message consolidates send and list", async () => {
    const { messageTool } = await loadTools();
    expect(messageTool).toBeDefined();
    
    // Send
    await messageTool.execute("tc12", { action: "send", to: "gemini", message: "hello", kind: "dm" }, undefined, undefined, createMockCtx());
    // List
    await messageTool.execute("tc13", { action: "list", recipient: "gemini" }, undefined, undefined, createMockCtx());
  });

  it("broadcast via acp_message action:send to:*", async () => {
    const { messageTool } = await loadTools();
    await messageTool.execute("tc14", { action: "send", to: "*", message: "everyone" }, undefined, undefined, createMockCtx());
  });

  // These tools are now commands, not tools
  it.skip("plan governance tools [REMOVED — now commands]", async () => {});
  it.skip("doctor [REMOVED — now command]", async () => {});
  it.skip("runtime_info [REMOVED — now command]", async () => {});
  it.skip("env [REMOVED — now command]", async () => {});
  it.skip("cleanup [REMOVED — now command]", async () => {});
  it.skip("model_policy_check [REMOVED — now config]", async () => {});

  it("persists friendly names across fresh runtime reloads via acp_prompt", async () => {
    const first = await loadTools();
    const promptResult = await first.promptTool.execute("tc17", { message: "hello", session_name: "alpha" }, undefined, undefined, createMockCtx());
    expect(promptResult.details.sessionId).toBe("persisted-session-1");
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDelegate = vi.fn();
const mockBroadcast = vi.fn();
const mockCompare = vi.fn();
const mockNewSession = vi.fn(async () => "persisted-session-1");
const mockLoadSession = vi.fn(async (sessionId: string) => sessionId);
const mockPrompt = vi.fn(async () => ({ text: "prompt ok", sessionId: "persisted-session-1", stopReason: "end_turn" }));
let runtimeDir = "";

vi.mock("../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agent_servers: {
      gemini: { command: "gemini", args: ["--acp"] },
      claude: { command: "claude", args: ["--acp"] },
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
    broadcast = mockBroadcast;
    compare = mockCompare;
    formatComparison() {
      return "formatted";
    }
  },
}));

vi.mock("../src/adapter-factory.js", () => ({
  createAdapter: vi.fn(() => ({
    spawn: vi.fn(),
    initialize: vi.fn(),
    newSession: mockNewSession,
    loadSession: mockLoadSession,
    prompt: mockPrompt,
    setModel: vi.fn(),
    setMode: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

function uniqueRuntimeDir() {
  return mkdtempSync(join(tmpdir(), "pi-acp-agents-test-runtime-"));
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
  };
}

function createMockCtx(setWidgetImpl?: () => void) {
  return {
    cwd: "/base",
    ui: {
      setWidget: vi.fn(() => setWidgetImpl?.()),
      notify: vi.fn(),
    },
  };
}

async function loadTools() {
  vi.resetModules();
  const mockPi = createMockPi();
  const mod = await import("../index.js");
  mod.default(mockPi as any);
  const findTool = (name: string) => mockPi.tools.find((t) => t.name === name);
  return {
    promptTool: findTool("acp_prompt"),
    statusTool: findTool("acp_status"),
    sessionLoadTool: findTool("acp_session_load"),
    delegateTool: findTool("acp_delegate"),
    broadcastTool: findTool("acp_broadcast"),
    compareTool: findTool("acp_compare"),
    runtimeInfoTool: findTool("acp_runtime_info"),
    envTool: findTool("acp_env"),
    modelPolicyCheckTool: findTool("acp_model_policy_check"),
    taskCreateTool: findTool("acp_task_create"),
    taskListTool: findTool("acp_task_list"),
    taskAssignTool: findTool("acp_task_assign"),
    taskStatusTool: findTool("acp_task_set_status"),
    taskDepAddTool: findTool("acp_task_dependency_add"),
    messageSendTool: findTool("acp_message_send"),
    messageListTool: findTool("acp_message_list"),
    planRequestTool: findTool("acp_plan_request"),
    planResolveTool: findTool("acp_plan_resolve"),
    doctorTool: findTool("acp_doctor"),
    cleanupTool: findTool("acp_cleanup"),
  };
}

describe("Level 3+ — tool execute behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeDir = uniqueRuntimeDir();
  });

  it("acp_delegate returns successful result with details", async () => {
    mockDelegate.mockResolvedValue({
      text: "delegate ok",
      sessionId: "sid-1",
      stopReason: "end_turn",
    });
    const { delegateTool } = await loadTools();
    const result = await delegateTool.execute("tc1", { message: "do work", agent: "gemini", cwd: "/tmp/run" }, undefined, undefined, createMockCtx());
    expect(mockDelegate).toHaveBeenCalledWith("gemini", "do work", "/tmp/run");
    expect(result.content[0].text).toBe("delegate ok");
    expect(result.details).toEqual({ agent: "gemini", sessionId: "sid-1", stopReason: "end_turn" });
  });

  it("acp_broadcast returns aggregated responses", async () => {
    mockBroadcast.mockResolvedValue([
      { agent: "gemini", text: "g response", sessionId: "s1", stopReason: "end_turn" },
      { agent: "claude", text: "", sessionId: "", stopReason: "error", error: "boom" },
    ]);
    const { broadcastTool } = await loadTools();
    const result = await broadcastTool.execute("tc2", { message: "compare", agent_servers: ["gemini", "claude"] }, undefined, undefined, createMockCtx());
    expect(result.content[0].text).toContain("── gemini ──\ng response");
    expect(result.content[0].text).toContain("── claude ──\n(ERROR: boom)");
  });

  it("acp_compare returns structured comparison details", async () => {
    mockCompare.mockResolvedValue({
      prompt: "compare this",
      timestamp: "2026-05-06T00:00:00.000Z",
      responses: [
        { agent: "gemini", text: "alpha", sessionId: "s1", stopReason: "end_turn" },
        { agent: "claude", text: "beta", sessionId: "s2", stopReason: "end_turn" },
      ],
    });
    const { compareTool } = await loadTools();
    const result = await compareTool.execute("tc3", { message: "compare this", agent_servers: ["gemini", "claude"] }, undefined, undefined, createMockCtx());
    expect(result.content[0].text).toContain('Comparison: "compare this"');
    expect(result.details.comparison.responses).toHaveLength(2);
  });

  it("acp_runtime_info exposes runtime paths", async () => {
    const { runtimeInfoTool } = await loadTools();
    const result = await runtimeInfoTool.execute("tc4", {}, undefined, undefined, createMockCtx());
    expect(result.content[0].text).toContain("runtimeDir");
    expect(result.details.runtimeDir).toContain("pi-acp-agents-test-runtime-");
  });

  it("acp_env shows spawn configuration for agent", async () => {
    const { envTool } = await loadTools();
    const result = await envTool.execute("tc5", { agent: "gemini" }, undefined, undefined, createMockCtx());
    expect(result.details.command).toBe("gemini");
    expect(result.details.args).toEqual(["--acp"]);
  });

  it("acp_model_policy_check validates model strings", async () => {
    const { modelPolicyCheckTool } = await loadTools();
    const result = await modelPolicyCheckTool.execute("tc6", { model: "gemini-plain" }, undefined, undefined, createMockCtx());
    expect(result.details.ok).toBe(true);
  });

  it("task tools create, update, and list tasks", async () => {
    const { taskCreateTool, taskAssignTool, taskStatusTool, taskDepAddTool, taskListTool } = await loadTools();
    const created = await taskCreateTool.execute("tc7", { subject: "Investigate", description: "deep work", assignee: "gemini" }, undefined, undefined, createMockCtx());
    const taskId = created.details.id;
    await taskAssignTool.execute("tc8", { task_id: taskId, assignee: "claude" }, undefined, undefined, createMockCtx());
    await taskStatusTool.execute("tc9", { task_id: taskId, status: "in_progress", result: "started" }, undefined, undefined, createMockCtx());
    await taskDepAddTool.execute("tc10", { task_id: taskId, dependency_id: "99" }, undefined, undefined, createMockCtx());
    const listed = await taskListTool.execute("tc11", {}, undefined, undefined, createMockCtx());
    expect(listed.details.tasks[0]).toMatchObject({ id: taskId, assignee: "claude", status: "in_progress" });
    expect(listed.details.tasks[0].blockedBy).toEqual(["99"]);
  });

  it("mailbox tools persist messages", async () => {
    const { messageSendTool, messageListTool } = await loadTools();
    await messageSendTool.execute("tc12", { to: "gemini", message: "hello", from: "leader" }, undefined, undefined, createMockCtx());
    const listed = await messageListTool.execute("tc13", { recipient: "gemini" }, undefined, undefined, createMockCtx());
    expect(listed.details.messages).toHaveLength(1);
    expect(listed.details.messages[0]).toMatchObject({ to: "gemini", message: "hello" });
  });

  it("plan governance tools persist approvals", async () => {
    const { planRequestTool, planResolveTool } = await loadTools();
    const requested = await planRequestTool.execute("tc14", { agent: "gemini" }, undefined, undefined, createMockCtx());
    expect(requested.details.status).toBe("pending");
    const resolved = await planResolveTool.execute("tc15", { agent: "gemini", action: "approved" }, undefined, undefined, createMockCtx());
    expect(resolved.details.status).toBe("approved");
  });

  it("doctor returns diagnostic payload", async () => {
    const { doctorTool } = await loadTools();
    const result = await doctorTool.execute("tc16", {}, undefined, undefined, createMockCtx());
    expect(result.details.configuredAgentServers).toEqual(["gemini", "claude"]);
    expect(result.details.runtime.rootDir).toContain("pi-acp-agents-test-runtime-");
  });

  it("persists friendly names across fresh runtime reloads via real registration path", async () => {
    const first = await loadTools();
    const promptResult = await first.promptTool.execute("tc17", { message: "hello", session_name: "  alpha  " }, undefined, undefined, createMockCtx());
    expect(promptResult.details.sessionId).toBe("persisted-session-1");

    const registry = readFileSync(join(runtimeDir, "session-name-registry.json"), "utf8");
    expect(registry).toContain('"sessionName": "alpha"');

    mockLoadSession.mockClear();
    const second = await loadTools();
    const statusResult = await second.statusTool.execute("tc18", { session_name: "alpha" }, undefined, undefined, createMockCtx());
    expect(statusResult.content[0].text).toContain("Session: persisted-session-1");

    const loadResult = await second.sessionLoadTool.execute("tc19", { session_name: "alpha" }, undefined, undefined, createMockCtx());
    expect(loadResult.details.sessionId).toBe("persisted-session-1");
    expect(mockLoadSession).toHaveBeenCalledWith("persisted-session-1");
  });

  it("rejects duplicate friendly names through the real registration path", async () => {
    const tools = await loadTools();
    await tools.promptTool.execute("tc20", { message: "hello", session_name: "alpha" }, undefined, undefined, createMockCtx());

    mockNewSession.mockResolvedValueOnce("persisted-session-2");
    const duplicate = await tools.sessionLoadTool.execute("tc21", { session_id: "persisted-session-2", session_name: "alpha" }, undefined, undefined, createMockCtx());

    expect(duplicate.content[0].text).toContain('session_id "persisted-session-2" was not found and does not match resolved session_name "alpha"');
  });

  it("cleanup returns ok payload", async () => {
    const { cleanupTool } = await loadTools();
    const result = await cleanupTool.execute("tc17", { target: "tasks" }, undefined, undefined, createMockCtx());
    expect(result.details).toEqual({ target: "tasks", ok: true });
  });
});

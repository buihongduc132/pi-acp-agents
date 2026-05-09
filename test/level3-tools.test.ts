import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Level 3+ — ACP management tool registration", () => {
  const registeredTools: string[] = [];

  const mockPi = {
    registerTool: vi.fn((tool: any) => {
      registeredTools.push(tool.name);
    }),
    registerCommand: vi.fn(),
    on: vi.fn(),
  };

  beforeEach(() => {
    registeredTools.length = 0;
    vi.clearAllMocks();
  });

  it("registers level 3 coordination tools", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toEqual(expect.arrayContaining(["acp_delegate", "acp_broadcast", "acp_compare"]));
  });

  it("registers lifecycle tools", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toEqual(expect.arrayContaining([
      "acp_session_list",
      "acp_session_shutdown",
      "acp_session_kill",
      "acp_prune",
      "acp_runtime_info",
      "acp_env",
      "acp_cleanup",
    ]));
  });

  it("registers task, messaging, governance, and diagnostic tools", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toEqual(expect.arrayContaining([
      "acp_task_create",
      "acp_task_list",
      "acp_task_get",
      "acp_task_assign",
      "acp_task_set_status",
      "acp_task_dependency_add",
      "acp_task_dependency_remove",
      "acp_task_clear",
      "acp_message_send",
      "acp_message_list",
      "acp_plan_request",
      "acp_plan_resolve",
      "acp_model_policy_get",
      "acp_model_policy_check",
      "acp_doctor",
      "acp_event_log",
    ]));
  });

  it("registers expanded tool count", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toEqual(expect.arrayContaining([
      "acp_prompt",
      "acp_status",
      "acp_session_new",
      "acp_session_load",
      "acp_session_set_model",
      "acp_session_set_mode",
      "acp_cancel",
    ]));
    expect(registeredTools.length).toBe(33);
  });
});

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
  });

  it("registers exactly 7 consolidated tools", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toEqual(expect.arrayContaining([
      "acp_prompt",
      "acp_status",
      "acp_cancel",
      "acp_broadcast",
      "acp_task_update",
      "acp_message",
      "acp_task_create",
    ]));
    expect(registeredTools.length).toBe(7);
  });

  it("does NOT register removed tools", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    const REMOVED = [
      "acp_session_new", "acp_session_load", "acp_session_set_model", "acp_session_set_mode",
      "acp_delegate", "acp_compare", "acp_delegate_parallel",
      "acp_session_list", "acp_session_shutdown", "acp_session_kill", "acp_prune",
      "acp_runtime_info", "acp_env", "acp_cleanup", "acp_doctor", "acp_event_log",
      "acp_task_list", "acp_task_get", "acp_task_assign", "acp_task_set_status",
      "acp_task_dependency_add", "acp_task_dependency_remove", "acp_task_clear",
      "acp_message_send", "acp_message_list",
      "acp_plan_request", "acp_plan_resolve",
      "acp_model_policy_get", "acp_model_policy_check",
    ];
    for (const tool of REMOVED) {
      expect(registeredTools).not.toContain(tool);
    }
  });
});

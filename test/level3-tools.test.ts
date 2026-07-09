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

  it("registers exactly the unified 13-tool surface (11 core + 2 hooks policy)", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toEqual(expect.arrayContaining([
      "acp_spawn",
      "acp_msg",
      "acp_fanout",
      "acp_governance",
      "acp_status",
      "acp_task_create",
      "acp_task_update",
      "acp_message",
      "acp_dag_submit",
      "acp_dag_status",
      "acp_dag_cancel",
      "acp_hooks_policy_get",
      "acp_hooks_policy_set",
    ]));
    // Hard break: exactly 13 tools (11 core + 2 hooks policy), no aliases.
    expect(registeredTools.length).toBe(13);
  });

  it("does NOT register removed tools", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    const REMOVED = [
      // first-wave consolidation
      "acp_session_new", "acp_session_load", "acp_session_set_model", "acp_session_set_mode",
      "acp_delegate", "acp_compare", "acp_delegate_parallel",
      "acp_session_list", "acp_session_shutdown", "acp_session_kill", "acp_prune",
      "acp_runtime_info", "acp_env", "acp_cleanup", "acp_doctor", "acp_event_log",
      "acp_task_list", "acp_task_get", "acp_task_assign", "acp_task_set_status",
      "acp_task_dependency_add", "acp_task_dependency_remove", "acp_task_clear",
      "acp_message_send", "acp_message_list",
      // unified-surface collapse (second wave)
      "acp_prompt", "acp_cancel", "acp_broadcast",
      "acp_worker_spawn", "acp_worker_list", "acp_worker_steer",
      "acp_worker_shutdown", "acp_worker_kill", "acp_worker_prune",
      "acp_plan_request", "acp_plan_resolve",
      "acp_model_policy_get", "acp_model_policy_check",
    ];
    for (const tool of REMOVED) {
      expect(registeredTools).not.toContain(tool);
    }
  });
});

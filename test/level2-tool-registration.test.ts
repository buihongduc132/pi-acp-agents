import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Tests that the unified 7-tool surface is registered in the extension entry point.
 *
 * Contract check: the unified tool set (post-second-wave-consolidation) must be
 * registered in index.ts. Old surface names (acp_prompt, acp_worker_*, etc.) are
 * asserted ABSENT.
 */
describe("Level 2 — tool registration in index.ts", () => {
  const indexPath = new URL("../index.ts", import.meta.url).pathname;
  const source = readFileSync(indexPath, "utf-8");

  const UNIFIED_TOOLS = [
    "acp_spawn",
    "acp_msg",
    "acp_fanout",
    "acp_governance",
    "acp_status",
    "acp_task",
    "acp_dag",
  ];

  const REMOVED_TOOLS = [
    // first-wave consolidation (already gone before unified surface)
    "acp_session_new", "acp_session_load", "acp_session_set_model", "acp_session_set_mode",
    "acp_delegate", "acp_compare", "acp_delegate_parallel",
    "acp_session_list", "acp_session_shutdown", "acp_session_kill", "acp_prune",
    "acp_runtime_info", "acp_env", "acp_cleanup", "acp_doctor", "acp_event_log",
    "acp_task_list", "acp_task_get", "acp_task_assign", "acp_task_set_status",
    "acp_task_dependency_add", "acp_task_dependency_remove", "acp_task_clear",
    "acp_message_send", "acp_message_list",
    // unified-surface collapse (second wave) — hard break, no aliases
    "acp_prompt", "acp_cancel", "acp_broadcast",
    "acp_worker_spawn", "acp_worker_list", "acp_worker_steer",
    "acp_worker_shutdown", "acp_worker_kill", "acp_worker_prune",
    // governance tools sunset as standalone (folded into acp_governance)
    "acp_plan_request", "acp_plan_resolve",
    "acp_model_policy_get", "acp_model_policy_check",
    // second-wave consolidation (11 → 7): folded into acp_msg/acp_task/acp_dag
    "acp_task_create", "acp_task_update", "acp_message",
    "acp_dag_submit", "acp_dag_status", "acp_dag_cancel",
  ];

  // Tools whose handlers route through safeExecute (circuit-breaker wrapped).
  const TOOLS_WITH_SAFEXECUTE = ["acp_spawn", "acp_msg", "acp_fanout"];

  for (const toolName of UNIFIED_TOOLS) {
    describe(`tool: ${toolName}`, () => {
      it("is registered with registerTool", () => {
        expect(source).toMatch(new RegExp(`name:\\s*["']${toolName}["']`));
      });

      it("has a description", () => {
        const regex = new RegExp(
          `name:\\s*["']${toolName}["'][\\s\\S]{0,500}?description:`,
        );
        expect(source).toMatch(regex);
      });
    });
  }

  // Only some tools route through safeExecute
  for (const toolName of TOOLS_WITH_SAFEXECUTE) {
    it(`${toolName} wraps through safeExecute (circuit breaker)`, () => {
      const regex = new RegExp(
        `name:\\s*["']${toolName}["'][\\s\\S]{0,12000}?safeExecute`,
      );
      expect(source).toMatch(regex);
    });
  }

  it("has no duplicate tool registrations", () => {
    for (const toolName of UNIFIED_TOOLS) {
      const regex = new RegExp(`^\\s*name:\\s*["']${toolName}["']`, "gm");
      const matches = source.match(regex);
      const count = matches ? matches.length : 0;
      expect(count).toBe(1);
    }
  });

  it("removed tools are NOT registered", () => {
    for (const toolName of REMOVED_TOOLS) {
      const regex = new RegExp(`^\\s*name:\\s*["']${toolName}["']`, "gm");
      const matches = source.match(regex);
      const count = matches ? matches.length : 0;
      expect(count).toBe(0);
    }
  });

  it("acp_msg references cancel (cancel:true path)", () => {
    // acp_msg absorbed acp_cancel; the unified handler must still invoke cancel.
    expect(source).toMatch(/\.cancel\(/);
  });
});

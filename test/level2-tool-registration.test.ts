import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Tests that the 7 consolidated tools are registered in the extension entry point.
 *
 * These tests verify the presence of tool registrations in index.ts source.
 * They serve as a contract check — the tools must exist for Level 2 to be complete.
 */
describe("Level 2 — tool registration in index.ts", () => {
  const indexPath = new URL("../index.ts", import.meta.url).pathname;
  const source = readFileSync(indexPath, "utf-8");

  const CONSOLIDATED_TOOLS = [
    "acp_prompt",
    "acp_status",
    "acp_cancel",
    "acp_broadcast",
    "acp_task_update",
    "acp_message",
    "acp_task_create",
  ];

  const REMOVED_TOOLS = [
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

  const TOOLS_WITH_SAFEXECUTE = ["acp_prompt", "acp_cancel", "acp_broadcast"];

  for (const toolName of CONSOLIDATED_TOOLS) {
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

  // Only some tools use safeExecute
  for (const toolName of TOOLS_WITH_SAFEXECUTE) {
    it(`${toolName} wraps through safeExecute (circuit breaker)`, () => {
      const regex = new RegExp(
        `name:\\s*["']${toolName}["'][\\s\\S]{0,2000}?safeExecute`,
      );
      expect(source).toMatch(regex);
    });
  }

  it("has no duplicate tool registrations", () => {
    for (const toolName of CONSOLIDATED_TOOLS) {
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

  it("acp_cancel references cancel method", () => {
    expect(source).toMatch(/\.cancel\(/);
  });
});

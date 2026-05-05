import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Tests that Level 2 tools are registered in the extension entry point.
 *
 * These tests verify the presence of tool registrations in index.ts source.
 * They serve as a contract check — the tools must exist for Level 2 to be complete.
 */
describe("Level 2 — tool registration in index.ts", () => {
  const indexPath = new URL("../index.ts", import.meta.url).pathname;
  const source = readFileSync(indexPath, "utf-8");

  const toolNames = [
    "acp_session_load",
    "acp_session_set_model",
    "acp_session_set_mode",
    "acp_cancel",
  ];

  for (const toolName of toolNames) {
    describe(`tool: ${toolName}`, () => {
      it("is registered with registerTool", () => {
        // Must have name: "toolName" inside a registerTool call
        expect(source).toMatch(new RegExp(`name:\\s*["']${toolName}["']`));
      });

      it("wraps through safeExecute (circuit breaker)", () => {
        // Find all occurrences of this tool name and check safeExecute nearby
        const regex = new RegExp(
          `name:\\s*["']${toolName}["'][\\s\\S]{0,2000}?safeExecute`,
        );
        expect(source).toMatch(regex);
      });

      it("has a description", () => {
        const regex = new RegExp(
          `name:\\s*["']${toolName}["'][\\s\\S]{0,500}?description:`,
        );
        expect(source).toMatch(regex);
      });
    });
  }

  it("acp_session_load references loadSession method", () => {
    expect(source).toMatch(/loadSession/);
  });

  it("acp_session_set_model references setModel method", () => {
    expect(source).toMatch(/setModel/);
  });

  it("acp_session_set_mode references setMode method", () => {
    expect(source).toMatch(/setMode/);
  });

  it("acp_cancel references cancel method", () => {
    expect(source).toMatch(/\.cancel\(/);
  });

  it("has no duplicate tool registrations", () => {
    for (const toolName of toolNames) {
      // Count occurrences of name: "toolName" (not in comments)
      const regex = new RegExp(`^\\s*name:\\s*["']${toolName}["']`, "gm");
      const matches = source.match(regex);
      const count = matches ? matches.length : 0;
      expect(count).toBe(1);
    }
  });
});

import { describe, it, expect, vi } from "vitest";
import { Type } from "typebox";
import type { Static } from "typebox";

/**
 * Level 2 — Verify new tools exist in the extension entry point.
 *
 * We dynamically import index.ts and inspect registered tools.
 * Since pi's ExtensionAPI is not available in test, we mock it.
 */
function createMockPi() {
  const tools: Array<{ name: string; parameters: Static<typeof Type.Object> }> = [];
  const commands: Array<{ name: string; description: string }> = [];

  return {
    tools,
    commands,
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string, opts: any) {
      commands.push({ name, description: opts.description ?? "" });
    },
    on() {},
  };
}

describe("Level 2 — Tool registration", () => {
  it("registers acp_session_load tool", async () => {
    const mock = createMockPi();
    const mod = await import("../index.js");
    (mod.default as any)(mock);
    const names = mock.tools.map((t: any) => t.name);
    expect(names).toContain("acp_session_load");
  });

  it("registers acp_session_set_model tool", async () => {
    const mock = createMockPi();
    const mod = await import("../index.js");
    (mod.default as any)(mock);
    const names = mock.tools.map((t: any) => t.name);
    expect(names).toContain("acp_session_set_model");
  });

  it("registers acp_session_set_mode tool", async () => {
    const mock = createMockPi();
    const mod = await import("../index.js");
    (mod.default as any)(mock);
    const names = mock.tools.map((t: any) => t.name);
    expect(names).toContain("acp_session_set_mode");
  });

  it("registers acp_cancel tool", async () => {
    const mock = createMockPi();
    const mod = await import("../index.js");
    (mod.default as any)(mock);
    const names = mock.tools.map((t: any) => t.name);
    expect(names).toContain("acp_cancel");
  });

  it("all Level 2 tools have session_id and session_name parameters", async () => {
    const mock = createMockPi();
    const mod = await import("../index.js");
    (mod.default as any)(mock);
    const l2Tools = mock.tools.filter((t: any) =>
      [
        "acp_session_load",
        "acp_session_set_model",
        "acp_session_set_mode",
        "acp_cancel",
      ].includes(t.name),
    );
    for (const tool of l2Tools) {
      if (tool.name === "acp_session_new") continue; // doesn't need session_id
      const props = (tool.parameters as any)?.properties;
      expect(props).toBeDefined();
      expect(props).toHaveProperty("session_id");
      expect(props).toHaveProperty("session_name");
    }
  });
});

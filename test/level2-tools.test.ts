import { describe, it, expect } from "vitest";

/**
 * Level 2 — Verify the unified tool surface is registered in the extension entry point.
 *
 * We dynamically import index.ts and inspect registered tools.
 * Since pi's ExtensionAPI is not available in test, we mock it.
 *
 * The unified surface collapsed the old session_* / cancel / prompt tools into
 * acp_spawn / acp_msg. These tests verify the consolidated tools register and
 * carry the addressing parameters (to / name) that replaced session_id/session_name.
 */
function createMockPi() {
  const tools: Array<{ name: string; parameters: any }> = [];
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

describe("Level 2 — Unified tool registration", () => {
  async function registeredNames() {
    const mock = createMockPi();
    const mod = await import("../index.js");
    (mod.default as any)(mock);
    return { names: mock.tools.map((t: any) => t.name), mock };
  }

  it("registers acp_spawn (absorbed acp_session_new + acp_worker_spawn)", async () => {
    const { names } = await registeredNames();
    expect(names).toContain("acp_spawn");
  });

  it("registers acp_msg (absorbed acp_session_load + acp_cancel + acp_prompt)", async () => {
    const { names } = await registeredNames();
    expect(names).toContain("acp_msg");
  });

  it("registers acp_status (absorbed acp_session_list)", async () => {
    const { names } = await registeredNames();
    expect(names).toContain("acp_status");
  });

  it("does NOT register removed session_* / cancel tools", async () => {
    const { names } = await registeredNames();
    for (const removed of [
      "acp_session_load",
      "acp_session_set_model",
      "acp_session_set_mode",
      "acp_cancel",
      "acp_session_new",
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it("acp_msg has an addressing parameter (to) replacing session_id/session_name", async () => {
    const { mock } = await registeredNames();
    const msg = mock.tools.find((t: any) => t.name === "acp_msg");
    expect(msg).toBeDefined();
    const props = msg!.parameters?.properties;
    expect(props).toBeDefined();
    // acp_msg addresses by `to` (id or name); auto-resolves alive/disposed.
    expect(props).toHaveProperty("to");
    expect(props).toHaveProperty("message");
  });

  it("acp_spawn has agent + optional name/prompt/claim parameters", async () => {
    const { mock } = await registeredNames();
    const spawn = mock.tools.find((t: any) => t.name === "acp_spawn");
    expect(spawn).toBeDefined();
    const props = spawn!.parameters?.properties;
    expect(props).toHaveProperty("agent");
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("claim");
  });
});

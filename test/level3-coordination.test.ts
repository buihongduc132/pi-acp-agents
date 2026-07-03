/**
 * Level 3 — Multi-agent coordination: tool registration tests.
 *
 * Tests that acp_delegate, acp_broadcast, and acp_compare tools
 * are registered in the extension entry point with correct parameters.
 */
import { describe, it, expect, vi } from "vitest";

function createMockPi() {
  const tools: Array<{ name: string; parameters: any; description: string }> = [];
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

async function loadTools() {
  const mock = createMockPi();
  const mod = await import("../index.js");
  (mod.default as any)(mock);
  return mock;
}

describe("Level 3 — Tool registration", () => {
  it.skip("registers acp_delegate tool [REMOVED]", async () => {
    const mock = await loadTools();
    const names = mock.tools.map((t) => t.name);
    expect(names).toContain("acp_delegate");
  });

  it("registers acp_broadcast tool", async () => {
    const mock = await loadTools();
    const names = mock.tools.map((t) => t.name);
    expect(names).toContain("acp_broadcast");
  });

  it.skip("registers acp_compare tool [REMOVED]", async () => {
    const mock = await loadTools();
    const names = mock.tools.map((t) => t.name);
    expect(names).toContain("acp_compare");
  });

  it.skip("acp_delegate has required parameters [REMOVED]", async () => {
    const mock = await loadTools();
    const tool = mock.tools.find((t) => t.name === "acp_delegate");
    expect(tool).toBeDefined();
    const props = tool!.parameters?.properties;
    expect(props).toHaveProperty("message");
    expect(props).toHaveProperty("agent");
    expect(props).toHaveProperty("cwd");
  });

  it("acp_broadcast has message and agents array parameter", async () => {
    const mock = await loadTools();
    const tool = mock.tools.find((t) => t.name === "acp_broadcast");
    expect(tool).toBeDefined();
    const props = tool!.parameters?.properties;
    expect(props).toHaveProperty("message");
    expect(props).toHaveProperty("agents");
    expect(props).toHaveProperty("cwd");
  });

  it.skip("acp_compare has message and agents array parameter [REMOVED]", async () => {
    const mock = await loadTools();
    const tool = mock.tools.find((t) => t.name === "acp_compare");
    expect(tool).toBeDefined();
    const props = tool!.parameters?.properties;
    expect(props).toHaveProperty("message");
    expect(props).toHaveProperty("agents");
    expect(props).toHaveProperty("cwd");
  });

  it("all Level 3 tools have descriptions", async () => {
    const mock = await loadTools();
    const l3Tools = mock.tools.filter((t) =>
      ["acp_broadcast"].includes(t.name),
    );
    expect(l3Tools.length).toBeGreaterThanOrEqual(1);
    for (const tool of l3Tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("registers at least the level 3 coordination surface (consolidated)", async () => {
    const mock = await loadTools();
    expect(mock.tools.length).toBeGreaterThanOrEqual(7);
  });
});

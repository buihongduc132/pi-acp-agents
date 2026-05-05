/**
 * Level 3 — Multi-agent coordination: tool registration tests.
 *
 * Tests that acp_delegate, acp_broadcast, and acp_compare tools
 * are registered in the extension entry point with correct parameters.
 */
import { describe, it, expect } from "vitest";

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
  it("registers acp_delegate tool", async () => {
    const mock = await loadTools();
    const names = mock.tools.map((t) => t.name);
    expect(names).toContain("acp_delegate");
  });

  it("registers acp_broadcast tool", async () => {
    const mock = await loadTools();
    const names = mock.tools.map((t) => t.name);
    expect(names).toContain("acp_broadcast");
  });

  it("registers acp_compare tool", async () => {
    const mock = await loadTools();
    const names = mock.tools.map((t) => t.name);
    expect(names).toContain("acp_compare");
  });

  it("acp_delegate has required parameters", async () => {
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

  it("acp_compare has message and agents array parameter", async () => {
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
      ["acp_delegate", "acp_broadcast", "acp_compare"].includes(t.name),
    );
    expect(l3Tools.length).toBe(3);
    for (const tool of l3Tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("total registered tools is 10 (L1=3 + L2=4 + L3=3)", async () => {
    const mock = await loadTools();
    expect(mock.tools.length).toBe(10);
  });
});

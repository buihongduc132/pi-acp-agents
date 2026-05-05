import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Level 3 — Multi-agent coordination tool registration tests.
 *
 * These test that the extension registers acp_delegate, acp_broadcast, acp_compare.
 */
describe("Level 3 — Multi-agent tool registration", () => {
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

  it("registers acp_delegate tool", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toContain("acp_delegate");
  });

  it("registers acp_broadcast tool", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toContain("acp_broadcast");
  });

  it("registers acp_compare tool", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toContain("acp_compare");
  });

  it("all 10 tools are registered (7 L1/L2 + 3 L3)", async () => {
    const mod = await import("../index.js");
    mod.default(mockPi as any);
    expect(registeredTools).toEqual(
      expect.arrayContaining([
        "acp_prompt",
        "acp_status",
        "acp_session_new",
        "acp_session_load",
        "acp_session_set_model",
        "acp_session_set_mode",
        "acp_cancel",
        "acp_delegate",
        "acp_broadcast",
        "acp_compare",
      ]),
    );
    expect(registeredTools).toHaveLength(10);
  });
});

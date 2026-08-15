import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("B1 — config path respects PI_CODING_AGENT_DIR", () => {
  const originalEnv = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalEnv;
    }
  });

  it("resolveConfigPath returns path under PI_CODING_AGENT_DIR when set", async () => {
    process.env.PI_CODING_AGENT_DIR = "/custom/pi/agent";
    const { resolveConfigPath } = await import("../src/config/config.js");
    const path = resolveConfigPath();
    expect(path).toContain("/custom/pi/agent");
    expect(path).toMatch(/acp-agents\/config\.json$/);
  });

  it("resolveConfigPath returns ~/.pi/... when PI_CODING_AGENT_DIR not set", async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const { resolveConfigPath } = await import("../src/config/config.js");
    const path = resolveConfigPath();
    expect(path).toMatch(/\.pi\/acp-agents\/config\.json$/);
  });
});

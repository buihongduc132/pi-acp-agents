import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("B8 — hooks config noise", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("loadHookConfig with nonexistent path produces no console output", async () => {
    const { loadHookConfig } = await import("../src/hooks/config.js");
    const result = loadHookConfig("/nonexistent/path/that/does/not/exist.json");
    
    // Should return defaults gracefully
    expect(result).toBeDefined();
    expect(result.enabled).toBeDefined();
    
    // Must NOT produce console warnings for missing config (silent defaults)
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

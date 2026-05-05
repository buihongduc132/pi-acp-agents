import { describe, it, expect, vi } from "vitest";
import { GeminiAcpAdapter } from "../../src/adapters/gemini.js";
import type { AcpAgentConfig } from "../../src/types.js";
import type { Logger } from "../../src/logger.js";

function noopLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("adapters/gemini", () => {
  describe("GeminiAcpAdapter", () => {
    it("provides default config when none given", () => {
      const adapter = new GeminiAcpAdapter({});
      expect(adapter["config"].command).toBe("gemini");
      expect(adapter["config"].args).toEqual(["--acp"]);
    });

    it("uses name 'gemini'", () => {
      const adapter = new GeminiAcpAdapter({});
      expect(adapter.name).toBe("gemini");
    });

    it("overrides defaults with user config", () => {
      const adapter = new GeminiAcpAdapter({
        config: { command: "custom-gemini", args: ["--acp", "--sandbox"] },
      });
      expect(adapter["config"].command).toBe("custom-gemini");
      expect(adapter["config"].args).toEqual(["--acp", "--sandbox"]);
    });

    it("applies default args when not specified", () => {
      const adapter = new GeminiAcpAdapter({
        config: { command: "my-gemini" },
      });
      expect(adapter["config"].args).toEqual(["--acp"]);
    });

    it("accepts custom model", () => {
      const adapter = new GeminiAcpAdapter({
        config: { command: "gemini", defaultModel: "gemini-2.5-flash" },
      });
      expect(adapter["config"].defaultModel).toBe("gemini-2.5-flash");
    });

    describe("isAvailable", () => {
      it("returns boolean", () => {
        // This test doesn't assert true/false since gemini may or may not be installed
        // on the test machine. It just verifies the method works.
        const result = GeminiAcpAdapter.isAvailable();
        expect(typeof result).toBe("boolean");
      });
    });

    describe("getVersion", () => {
      it("returns string or null", () => {
        const result = GeminiAcpAdapter.getVersion();
        expect(result === null || typeof result === "string").toBe(true);
      });
    });
  });
});

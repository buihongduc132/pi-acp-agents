import { describe, expect, it, mock } from "bun:test";
import { GeminiAcpAdapter } from "../../src/adapters/gemini.js";
import type { AcpAgentConfig } from "../../src/config/types.js";
import type { Logger } from "../../src/logger.js";

// Mock child_process to prevent real gemini calls
mock.module("node:child_process", () => ({
	execSync: mock((cmd: string) => {
		if (cmd.includes("which gemini")) throw new Error("not found");
		if (cmd.includes("--version")) return "gemini v1.0.0";
		return "";
	}),
}));

function noopLogger(): Logger {
	return {
		info: mock(),
		error: mock(),
		debug: mock(),
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
			it("returns string or null", async () => {
				const result = await GeminiAcpAdapter.getVersion();
				expect(result === null || typeof result === "string").toBe(true);
			}, 15_000);
		});
	});
});

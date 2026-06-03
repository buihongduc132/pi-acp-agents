/**
 * Branch coverage for config/config.ts AGENT_PRESETS
 * These preset functions call execSync and need mocking
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `acp-presets-test-${process.pid}`);

// Mock node:child_process for execSync
const mockExecSync = mock((cmd: string) => {
	throw new Error("not found");
});
mock.module("node:child_process", () => ({
	execSync: mockExecSync,
}));

describe("AGENT_PRESETS", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		mockExecSync.mockImplementation(() => {
			throw new Error("not found");
		});
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("gemini preset returns config when binary found", async () => {
		const { AGENT_PRESETS } = await import("../src/config/config.js");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("which gemini")) return "";
			throw new Error("not found");
		});
		const result = AGENT_PRESETS.gemini?.();
		expect(result).toEqual({ command: "gemini", args: ["--acp"] });
	});

	it("gemini preset returns null when not found", async () => {
		const { AGENT_PRESETS } = await import("../src/config/config.js");
		mockExecSync.mockImplementation(() => { throw new Error("not found"); });
		const result = AGENT_PRESETS.gemini?.();
		expect(result).toBeNull();
	});

	it("opencode preset returns config for 'opencode' binary", async () => {
		const { AGENT_PRESETS } = await import("../src/config/config.js");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("which opencode")) return "";
			throw new Error("not found");
		});
		const result = AGENT_PRESETS.opencode?.();
		expect(result).toEqual({ command: "opencode", args: ["acp"] });
	});

	it("opencode preset returns config for 'ocxo' binary", async () => {
		const { AGENT_PRESETS } = await import("../src/config/config.js");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("which opencode")) throw new Error("not found");
			if (cmd.includes("which ocxo")) return "";
			throw new Error("not found");
		});
		const result = AGENT_PRESETS.opencode?.();
		expect(result).toEqual({ command: "ocxo", args: ["acp"] });
	});

	it("opencode preset returns null when neither found", async () => {
		const { AGENT_PRESETS } = await import("../src/config/config.js");
		mockExecSync.mockImplementation(() => { throw new Error("not found"); });
		const result = AGENT_PRESETS.opencode?.();
		expect(result).toBeNull();
	});

	it("codex preset returns config when binary found", async () => {
		const { AGENT_PRESETS } = await import("../src/config/config.js");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("which codex-acp")) return "";
			throw new Error("not found");
		});
		const result = AGENT_PRESETS.codex?.();
		expect(result).toEqual({ command: "codex-acp", args: [] });
	});

	it("codex preset returns null when not found", async () => {
		const { AGENT_PRESETS } = await import("../src/config/config.js");
		mockExecSync.mockImplementation(() => { throw new Error("not found"); });
		const result = AGENT_PRESETS.codex?.();
		expect(result).toBeNull();
	});
});

/**
 * TDD tests for Config CRUD functions.
 *
 * T1-T10 from plan: saveConfig, upsertAgentServer, removeAgentServer,
 * setDefaultAgent, detectAvailablePresets.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	saveConfig,
	upsertAgentServer,
	removeAgentServer,
	setDefaultAgent,
	detectAvailablePresets,
	loadConfig,
	validateConfig,
	DEFAULT_CONFIG,
	resolveConfigPath,
} from "../src/config/config.js";
import type { AcpConfig, AcpAgentConfig } from "../src/config/types.js";

// ── Helpers ──────────────────────────────────────────────

function makeConfig(agents: Record<string, AcpAgentConfig> = {}): AcpConfig {
	return {
		...structuredClone(DEFAULT_CONFIG),
		agent_servers: agents,
	};
}

let tmpDir: string;

// ── Tests ────────────────────────────────────────────────

describe("Config CRUD", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-crud-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── T1: Save config roundtrip ────────────────────────

	describe("saveConfig", () => {
		it("T1: saveConfig → loadConfig roundtrip preserves data", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"], env: { FOO: "bar" } },
				claude: { command: "claude-agent-acp", args: ["--acp"] },
			});
			config.defaultAgent = "gemini";
			config.stallTimeoutMs = 120_000;

			const configPath = join(tmpDir, "config.json");
			saveConfig(config, configPath);

			// File must exist on disk
			expect(existsSync(configPath)).toBe(true);

			// Load and verify roundtrip
			const loaded = loadConfig(configPath);
			expect(Object.keys(loaded.agent_servers)).toEqual(["gemini", "claude"]);
			expect(loaded.agent_servers.gemini.command).toBe("gemini");
			expect(loaded.agent_servers.gemini.args).toEqual(["--acp"]);
			expect(loaded.agent_servers.gemini.env).toEqual({ FOO: "bar" });
			expect(loaded.agent_servers.claude.command).toBe("claude-agent-acp");
			expect(loaded.defaultAgent).toBe("gemini");
			expect(loaded.stallTimeoutMs).toBe(120_000);
		});

		it("creates parent directories if missing", () => {
			const config = makeConfig();
			const configPath = join(tmpDir, "nested", "deep", "config.json");
			saveConfig(config, configPath);
			expect(existsSync(configPath)).toBe(true);
		});

		it("gracefully handles write failure (no throw)", () => {
			const config = makeConfig();
			expect(() => saveConfig(config, "/nonexistent/path/that/cannot/be/created/because/permissions/config.json")).not.toThrow();
		});
	});

	// ── T2: Upsert adds new agent ────────────────────────

	describe("upsertAgentServer", () => {
		it("T2: adds new agent to existing config", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			const updated = upsertAgentServer(config, "claude", {
				command: "claude-agent-acp",
			});
			expect(Object.keys(updated.agent_servers)).toEqual(["gemini", "claude"]);
			expect(updated.agent_servers.claude.command).toBe("claude-agent-acp");
			expect(updated.agent_servers.claude.args).toEqual([]);
			expect(updated.agent_servers.claude.env).toEqual({});
		});

		// ── T3: Upsert updates existing ────────────────────

		it("T3: updates existing agent config", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			const updated = upsertAgentServer(config, "gemini", {
				command: "gemini",
				args: ["--acp", "--model", "x"],
			});
			expect(Object.keys(updated.agent_servers)).toEqual(["gemini"]);
			expect(updated.agent_servers.gemini.args).toEqual(["--acp", "--model", "x"]);
		});

		it("does not mutate original config", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			const originalKeys = Object.keys(config.agent_servers);
			upsertAgentServer(config, "claude", { command: "claude-agent-acp" });
			expect(Object.keys(config.agent_servers)).toEqual(originalKeys);
		});

		// ── T9: Reject empty command ───────────────────────

		it("T9: rejects empty command", () => {
			const config = makeConfig();
			expect(() => upsertAgentServer(config, "x", { command: "" })).toThrow(/command/i);
		});

		// ── T10: Reject empty name ─────────────────────────

		it("T10: rejects empty name", () => {
			const config = makeConfig();
			expect(() => upsertAgentServer(config, "", { command: "x" })).toThrow(/name/i);
		});

		it("rejects whitespace-only name", () => {
			const config = makeConfig();
			expect(() => upsertAgentServer(config, "   ", { command: "x" })).toThrow(/name/i);
		});
	});

	// ── T4: Remove agent ─────────────────────────────────

	describe("removeAgentServer", () => {
		it("T4: removes existing agent, keeps others", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
				claude: { command: "claude-agent-acp", args: ["--acp"] },
			});
			const updated = removeAgentServer(config, "gemini");
			expect(Object.keys(updated.agent_servers)).toEqual(["claude"]);
			expect(updated.agent_servers.claude.command).toBe("claude-agent-acp");
		});

		// ── T5: Remove last agent ──────────────────────────

		it("T5: removes last agent, agent_servers empty, saveConfig succeeds", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			const updated = removeAgentServer(config, "gemini");
			expect(updated.agent_servers).toEqual({});
			// saveConfig should succeed with empty agent_servers (relaxed validation)
			const configPath = join(tmpDir, "config.json");
			expect(() => saveConfig(updated, configPath)).not.toThrow();
		});

		// ── T6: Remove unknown agent ───────────────────────

		it("T6: remove unknown agent is no-op", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			const updated = removeAgentServer(config, "nonexistent");
			expect(Object.keys(updated.agent_servers)).toEqual(["gemini"]);
		});

		it("does not mutate original config", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			removeAgentServer(config, "gemini");
			expect(config.agent_servers.gemini).toBeDefined();
		});
	});

	// ── T7/T8: Set default agent ─────────────────────────

	describe("setDefaultAgent", () => {
		it("T7: sets defaultAgent to existing agent", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
				claude: { command: "claude-agent-acp", args: [] },
				opencode: { command: "opencode", args: ["acp"] },
			});
			const updated = setDefaultAgent(config, "claude");
			expect(updated.defaultAgent).toBe("claude");
		});

		// ── T8: Set default to unknown ─────────────────────

		it("T8: throws if agent not in agent_servers", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			expect(() => setDefaultAgent(config, "nonexistent")).toThrow(/not found/i);
		});

		it("does not mutate original config", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
			});
			setDefaultAgent(config, "gemini");
			expect(config.defaultAgent).toBeUndefined();
		});

		it("unsets defaultAgent when agent removed and was default", () => {
			const config = makeConfig({
				gemini: { command: "gemini", args: ["--acp"] },
				claude: { command: "claude", args: [] },
			});
			const withDefault = setDefaultAgent(config, "gemini");
			const afterRemove = removeAgentServer(withDefault, "gemini");
			// removeAgentServer auto-clears defaultAgent when the default is removed
			expect(afterRemove.defaultAgent).toBeUndefined();
		});
	});

	// ── detectAvailablePresets ───────────────────────────

	describe("detectAvailablePresets", () => {
		it("returns array of { name, config } for available presets", () => {
			const presets = detectAvailablePresets();
			expect(Array.isArray(presets)).toBe(true);
			for (const p of presets) {
				expect(p).toHaveProperty("name");
				expect(p).toHaveProperty("config");
				expect(p.config).toHaveProperty("command");
				expect(typeof p.config.command).toBe("string");
				expect(p.config.command.length).toBeGreaterThan(0);
			}
		});
	});
});

// ── validateConfig relaxed for empty agent_servers ──────

describe("validateConfig — relaxed empty check", () => {
	it("accepts empty agent_servers", () => {
		const config = validateConfig({ agent_servers: {} });
		expect(config.agent_servers).toEqual({});
	});

	it("still rejects missing agent_servers", () => {
		expect(() => validateConfig({} as any)).toThrow(/agent_servers/i);
	});

	it("still rejects invalid agent entries", () => {
		expect(() =>
			validateConfig({ agent_servers: { bad: { args: ["--acp"] } } } as any)
		).toThrow(/command/i);
	});
});

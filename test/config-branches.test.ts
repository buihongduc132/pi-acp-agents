/**
 * Additional branch coverage for config/config.ts
 * Targets: numeric field validation, timeout order, getAgentConfig, empty name,
 * migrateLegacyConfig with auto-save, loadConfig with invalid JSON
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock homedir but keep tmpdir
const FAKE_HOME = join(tmpdir(), `acp-config-branch-test-${process.pid}`);
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal() as any;
	return {
		...actual,
		homedir: () => join(actual.tmpdir(), `acp-config-branch-test-${process.pid}`),
	};
});

import { validateConfig, getAgentConfig, loadConfig, resolveConfigPath } from "../../src/config/config.js";

describe("config.ts — branch coverage", () => {
	beforeEach(() => {
		mkdirSync(FAKE_HOME, { recursive: true });
	});
	afterEach(() => {
		rmSync(FAKE_HOME, { recursive: true, force: true });
	});

	describe("validateConfig", () => {
		it("throws on empty agent name", () => {
			expect(() =>
				validateConfig({
					agent_servers: { "": { command: "test", args: [] } },
				} as any),
			).toThrow("non-empty string");
		});

		it("throws on whitespace-only agent name", () => {
			expect(() =>
				validateConfig({
					agent_servers: { "   ": { command: "test", args: [] } },
				} as any),
			).toThrow("non-empty string");
		});

		it("throws on non-object agent config", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: "not an object" },
				} as any),
			).toThrow("must be an object");
		});

		it("throws on missing command", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: { args: [] } },
				} as any),
			).toThrow('"command" is required');
		});

		it("throws on empty command", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: { command: "", args: [] } },
				} as any),
			).toThrow('"command" is required');
		});

		it("throws on negative staleTimeoutMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: { command: "a", args: [] } },
					staleTimeoutMs: -1,
				} as any),
			).toThrow("non-negative");
		});

		it("throws on negative healthCheckIntervalMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: { command: "a", args: [] } },
					healthCheckIntervalMs: -1,
				} as any),
			).toThrow("non-negative");
		});

		it("throws on negative circuitBreakerResetMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: { command: "a", args: [] } },
					circuitBreakerResetMs: -1,
				} as any),
			).toThrow("non-negative");
		});

		it("throws on negative circuitBreakerMaxFailures", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: { command: "a", args: [] } },
					circuitBreakerMaxFailures: -1,
				} as any),
			).toThrow("non-negative");
		});

		it("throws when healthCheckIntervalMs > staleTimeoutMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { test: { command: "a", args: [] } },
					healthCheckIntervalMs: 100,
					staleTimeoutMs: 50,
				} as any),
			).toThrow("healthCheckIntervalMs must be <= staleTimeoutMs");
		});

		it("fills defaults for args and env when not provided", () => {
			const result = validateConfig({
				agent_servers: { test: { command: "a" } },
			} as any);
			expect(result.agent_servers.test.args).toEqual([]);
			expect(result.agent_servers.test.env).toEqual({});
		});

		it("clamps stallTimeoutMs to minimum 60000", () => {
			const result = validateConfig({
				agent_servers: { test: { command: "a", args: [] } },
				stallTimeoutMs: 1000,
			} as any);
			expect(result.stallTimeoutMs).toBe(60_000);
		});

		it("uses provided stallTimeoutMs when >= 60000", () => {
			const result = validateConfig({
				agent_servers: { test: { command: "a", args: [] } },
				stallTimeoutMs: 120_000,
			} as any);
			expect(result.stallTimeoutMs).toBe(120_000);
		});
	});

	describe("getAgentConfig", () => {
		it("throws for unknown agent", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "g", args: [] } },
			});
			expect(() => getAgentConfig(config, "unknown")).toThrow('Agent "unknown" not found');
		});
	});

	describe("loadConfig", () => {
		it("returns defaults when config file has invalid JSON", () => {
			const configDir = join(FAKE_HOME, ".pi", "acp-agents");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "config.json"), "not json {{{");
			const config = loadConfig();
			expect(config.agent_servers).toEqual({});
		});

		it("migrates old agents key and auto-saves", () => {
			const configDir = join(FAKE_HOME, ".pi", "acp-agents");
			mkdirSync(configDir, { recursive: true });
			const configPath = join(configDir, "config.json");
			writeFileSync(configPath, JSON.stringify({
				agents: {
					test: { command: "test-cmd", args: [] },
				},
			}));

			const config = loadConfig();
			expect(config.agent_servers.test).toBeDefined();
			expect(config.agent_servers.test.command).toBe("test-cmd");

			// Verify auto-saved with agent_servers key
			const saved = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(saved.agent_servers).toBeDefined();
			expect(saved.agents).toBeUndefined();
		});

		it("returns defaults when config file does not exist", () => {
			const config = loadConfig("/nonexistent/path.json");
			expect(config.agent_servers).toEqual({});
		});
	});

	describe("validateConfig — empty agent_servers", () => {
		it("throws when agent_servers is empty object", () => {
			expect(() =>
				validateConfig({
					agent_servers: {},
				} as any),
			).toThrow("at least one agent");
		});

		it("throws when agent_servers is null", () => {
			expect(() =>
				validateConfig({
					agent_servers: null,
				} as any),
			).toThrow('"agent_servers" object');
		});
	});
});

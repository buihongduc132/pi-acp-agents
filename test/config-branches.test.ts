/**
 * Additional branch coverage for config/config.ts
 * Targets: numeric field validation, timeout order, getAgentConfig, empty name,
 * migrateLegacyConfig with auto-save, loadConfig with invalid JSON
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use explicit temp dirs instead of mocking node:os (CONFIG_PATH is evaluated at module load)
const TEST_DIR = join(tmpdir(), `acp-config-branch-test-${process.pid}`);

import { validateConfig, getAgentConfig, loadConfig, resolveConfigPath } from "../src/config/config.js";

describe("config.ts — branch coverage", () => {


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
		beforeEach(() => {
			mkdirSync(TEST_DIR, { recursive: true });
		});
		afterEach(() => {
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		it("returns defaults when config file has invalid JSON", () => {
			const configPath = join(TEST_DIR, "config.json");
			writeFileSync(configPath, "not json {{{");
			const config = loadConfig(configPath);
			expect(config.agent_servers).toEqual({});
		});

		it("migrates old agents key and auto-saves", () => {
			const configPath = join(TEST_DIR, "config.json");
			writeFileSync(configPath, JSON.stringify({
				agents: {
					test: { command: "test-cmd", args: [] },
				},
			}));

			const config = loadConfig(configPath);
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
		it("accepts empty agent_servers", () => {
			const result = validateConfig({ agent_servers: {} });
			expect(result.agent_servers).toEqual({});
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

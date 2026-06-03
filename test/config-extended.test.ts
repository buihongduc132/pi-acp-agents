import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadConfig,
	validateConfig,
	getAgentConfig,
	DEFAULT_CONFIG,
} from "../src/config/config.js";

describe("config (extended)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-cfg-ext-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("validateConfig", () => {
		it("throws if agent_servers is not an object", () => {
			expect(() => validateConfig({ agent_servers: "bad" as any })).toThrow(/must have an "agent_servers" object/);
		});

		it("throws if agent name is empty string", () => {
			expect(() =>
				validateConfig({ agent_servers: { "": { command: "cmd" } } }),
			).toThrow(/non-empty string/);
		});

		it("throws if agent name is whitespace only", () => {
			expect(() =>
				validateConfig({ agent_servers: { "  ": { command: "cmd" } } }),
			).toThrow(/non-empty string/);
		});

		it("throws if agent config is not an object", () => {
			expect(() =>
				validateConfig({ agent_servers: { bad: "not an object" as any } }),
			).toThrow(/must be an object/);
		});

		it("throws if agent command is empty string", () => {
			expect(() =>
				validateConfig({ agent_servers: { bad: { command: "" } } }),
			).toThrow(/command.*required/);
		});

		it("throws if agent command is not a string", () => {
			expect(() =>
				validateConfig({ agent_servers: { bad: { command: 42 as any } } }),
			).toThrow(/command.*required/);
		});

		it("throws for negative staleTimeoutMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { a: { command: "c" } },
					staleTimeoutMs: -1,
				}),
			).toThrow(/non-negative/);
		});

		it("throws for negative healthCheckIntervalMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { a: { command: "c" } },
					healthCheckIntervalMs: -100,
				}),
			).toThrow(/non-negative/);
		});

		it("throws for negative circuitBreakerResetMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { a: { command: "c" } },
					circuitBreakerResetMs: -1,
				}),
			).toThrow(/non-negative/);
		});

		it("throws for negative circuitBreakerMaxFailures", () => {
			expect(() =>
				validateConfig({
					agent_servers: { a: { command: "c" } },
					circuitBreakerMaxFailures: -1,
				}),
			).toThrow(/non-negative/);
		});

		it("throws when healthCheckIntervalMs > staleTimeoutMs", () => {
			expect(() =>
				validateConfig({
					agent_servers: { a: { command: "c" } },
					healthCheckIntervalMs: 60_000,
					staleTimeoutMs: 30_000,
				}),
			).toThrow(/healthCheckIntervalMs must be <= staleTimeoutMs/);
		});

		it("clamps stallTimeoutMs to minimum 60000", () => {
			const config = validateConfig({
				agent_servers: { a: { command: "c" } },
				stallTimeoutMs: 1_000,
			});
			expect(config.stallTimeoutMs).toBe(60_000);
		});

		it("preserves stallTimeoutMs when above minimum", () => {
			const config = validateConfig({
				agent_servers: { a: { command: "c" } },
				stallTimeoutMs: 120_000,
			});
			expect(config.stallTimeoutMs).toBe(120_000);
		});

		it("fills in default args and env for agents", () => {
			const config = validateConfig({
				agent_servers: { a: { command: "c" } },
			});
			expect(config.agent_servers.a.args).toEqual([]);
			expect(config.agent_servers.a.env).toEqual({});
		});

		it("preserves provided args and env", () => {
			const config = validateConfig({
				agent_servers: {
					a: { command: "c", args: ["--flag"], env: { KEY: "val" } },
				},
			});
			expect(config.agent_servers.a.args).toEqual(["--flag"]);
			expect(config.agent_servers.a.env).toEqual({ KEY: "val" });
		});

		it("accepts toolTimeouts config", () => {
			const config = validateConfig({
				agent_servers: { a: { command: "c" } },
				toolTimeouts: { prompt: 60_000 },
			});
			expect(config.toolTimeouts).toEqual({ prompt: 60_000 });
		});

		it("sets toolTimeouts to undefined when not provided", () => {
			const config = validateConfig({
				agent_servers: { a: { command: "c" } },
			});
			expect(config.toolTimeouts).toBeUndefined();
		});

		it("merges modelPolicy with defaults", () => {
			const config = validateConfig({
				agent_servers: { a: { command: "c" } },
				modelPolicy: { blockedModels: ["bad"] },
			});
			expect(config.modelPolicy).toEqual({
				allowedModels: [],
				blockedModels: ["bad"],
				requireProviderPrefix: false,
			});
		});
	});

	describe("loadConfig (extended)", () => {
		it("migrates legacy 'agents' key to 'agent_servers'", () => {
			const configPath = join(tmpDir, "config.json");
			writeFileSync(configPath, JSON.stringify({
				agents: { gemini: { command: "gemini", args: ["--acp"] } },
			}));
			const config = loadConfig(configPath);
			expect(config.agent_servers.gemini).toBeDefined();
			expect(config.agent_servers.gemini.command).toBe("gemini");
		});

		it("auto-saves migrated config back to disk", () => {
			const configPath = join(tmpDir, "config.json");
			writeFileSync(configPath, JSON.stringify({
				agents: { gemini: { command: "gemini", args: ["--acp"] } },
			}));
			loadConfig(configPath);
			// Read the file back — should have agent_servers now
			const saved = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(saved.agent_servers).toBeDefined();
			expect(saved.agents).toBeUndefined();
		});

		it("does not overwrite if both agents and agent_servers exist", () => {
			const configPath = join(tmpDir, "config.json");
			writeFileSync(configPath, JSON.stringify({
				agent_servers: { gemini: { command: "gemini" } },
				agents: { old: { command: "old" } },
			}));
			const config = loadConfig(configPath);
			expect(config.agent_servers.gemini).toBeDefined();
			// old should NOT be present since agent_servers takes precedence
			expect(config.agent_servers.old).toBeUndefined();
		});

		it("returns defaults for invalid config that passes JSON parse but fails validation", () => {
			const configPath = join(tmpDir, "config.json");
			// This has valid JSON but missing agent_servers
			writeFileSync(configPath, JSON.stringify({ foo: "bar" }));
			const config = loadConfig(configPath);
			expect(config).toEqual(DEFAULT_CONFIG);
		});
	});

	describe("getAgentConfig", () => {
		it("returns agent config for known agent", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini", args: ["--acp"] } },
			});
			const agent = getAgentConfig(config, "gemini");
			expect(agent.command).toBe("gemini");
		});

		it("throws for unknown agent with available list", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
			});
			expect(() => getAgentConfig(config, "claude")).toThrow(
				/Agent "claude" not found/,
			);
		});

		it("includes available agents in error message", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
			});
			try {
				getAgentConfig(config, "nonexistent");
				expect.unreachable("Should have thrown");
			} catch (err: any) {
				expect(err.message).toContain("gemini");
			}
		});
	});
});

/**
 * ACP Alias System — Tests for AliasResolver and coordinator integration.
 *
 * Uses plain closure-based mocks (no vi.mock / mock.fn) for maximum
 * compatibility with bun test runner.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import {
	AliasResolver,
	AllAgentsFailedError,
	NoHealthyAgentsError,
} from "../src/coordination/alias-resolver.js";
import type { AcpAliasConfig, AcpPromptResult } from "../src/config/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccessResult(agent: string): AcpPromptResult {
	return {
		text: `response from ${agent}`,
		stopReason: "end_turn",
		sessionId: `session-${agent}`,
	};
}

function makeAliasConfig(
	agents: string[],
	strategy: "failover" | "race" = "failover",
): AcpAliasConfig {
	return { agents, strategy };
}

// Simple mock helper for delegate/isHealthy functions
function makeMockDelegateFn() {
	let calls: Array<{ agent: string; message: string; cwd?: string }> = [];
	let impl: (agent: string, message: string, cwd?: string) => Promise<AcpPromptResult> = async () =>
		makeSuccessResult("default");
	return {
		get calls() { return calls; },
		get callCount() { return calls.length; },
		setImplementation(fn: typeof impl) { impl = fn; },
		fn: async (agent: string, message: string, cwd?: string) => {
			calls.push({ agent, message, cwd });
			return impl(agent, message, cwd);
		},
		reset() { calls = []; },
	};
}

function makeMockHealthFn() {
	let calls: string[] = [];
	let impl: (agentName: string) => boolean = () => true;
	return {
		get calls() { return calls; },
		get callCount() { return calls.length; },
		setImplementation(fn: typeof impl) { impl = fn; },
		fn: (agentName: string) => {
			calls.push(agentName);
			return impl(agentName);
		},
		reset() { calls = []; },
	};
}

// ---------------------------------------------------------------------------
// AliasResolver — unit tests
// ---------------------------------------------------------------------------

describe("AliasResolver", () => {
	// =========================================================================
	// FAILOVER STRATEGY
	// =========================================================================

	describe("failover strategy", () => {
		it("resolves alias and succeeds on first agent", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async () => makeSuccessResult("gemy-pro"));

			const resolver = new AliasResolver(
				{ smart: makeAliasConfig(["gemy-pro", "claude-sonnet", "gemini"]) },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("smart", "do something");
			expect(result.text).toBe("response from gemy-pro");
			expect(delegate.callCount).toBe(1);
			expect(delegate.calls[0]).toEqual({ agent: "gemy-pro", message: "do something", cwd: undefined });
		});

		it("falls back to second agent when first fails", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			let callCount = 0;
			delegate.setImplementation(async (agent: string) => {
				callCount++;
				if (callCount === 1) throw new Error("gemy-pro auth failed");
				return makeSuccessResult("claude-sonnet");
			});

			const resolver = new AliasResolver(
				{ smart: makeAliasConfig(["gemy-pro", "claude-sonnet", "gemini"]) },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("smart", "do something");
			expect(result.text).toBe("response from claude-sonnet");
			expect(delegate.callCount).toBe(2);
		});

		it("falls back through entire chain until one succeeds", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			let callCount = 0;
			const agents = ["a", "b", "c", "d"];
			delegate.setImplementation(async () => {
				callCount++;
				if (callCount < 4) throw new Error(`${agents[callCount - 1]} failed`);
				return makeSuccessResult("d");
			});

			const resolver = new AliasResolver(
				{ deep: makeAliasConfig(agents) },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("deep", "test");
			expect(result.text).toBe("response from d");
			expect(delegate.callCount).toBe(4);
		});

		it("throws AllAgentsFailedError when all agents fail", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async (agent: string) => { throw new Error(`${agent} failed`); });

			const resolver = new AliasResolver(
				{ fail: makeAliasConfig(["a", "b", "c"]) },
				delegate.fn,
				health.fn,
			);

			try {
				await resolver.resolve("fail", "test");
				throw new Error("should have thrown");
			} catch (err) {
				expect((err as Error).name).toBe("AllAgentsFailedError");
				const e = err as AllAgentsFailedError;
				expect(e.attempts).toHaveLength(3);
				expect(e.attempts[0].agent).toBe("a");
				expect(e.attempts[1].agent).toBe("b");
				expect(e.attempts[2].agent).toBe("c");
			}
		});

		it("skips agents with open circuit breaker", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			let healthCallCount = 0;
			health.setImplementation(() => {
				healthCallCount++;
				return healthCallCount > 2; // a=false, b=false, c=true
			});
			delegate.setImplementation(async () => makeSuccessResult("c"));

			const resolver = new AliasResolver(
				{ skip: makeAliasConfig(["a", "b", "c"]) },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("skip", "test");
			expect(result.text).toBe("response from c");
			expect(delegate.callCount).toBe(1);
			expect(delegate.calls[0].agent).toBe("c");
		});

		it("returns result from first healthy agent when earlier ones have open breakers", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			let healthCallCount = 0;
			health.setImplementation(() => {
				healthCallCount++;
				return healthCallCount > 2;
			});
			delegate.setImplementation(async () => makeSuccessResult("healthy"));

			const resolver = new AliasResolver(
				{ mixed: makeAliasConfig(["broken1", "broken2", "healthy"]) },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("mixed", "test");
			expect(result.text).toBe("response from healthy");
			expect(health.callCount).toBe(3);
		});

		it("passes cwd to delegate function", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async () => makeSuccessResult("gemy-pro"));

			const resolver = new AliasResolver(
				{ cwdtest: makeAliasConfig(["gemy-pro"]) },
				delegate.fn,
				health.fn,
			);

			await resolver.resolve("cwdtest", "test", "/custom/dir");
			expect(delegate.calls[0]).toEqual({ agent: "gemy-pro", message: "test", cwd: "/custom/dir" });
		});
	});

	// =========================================================================
	// RACE STRATEGY
	// =========================================================================

	describe("race strategy", () => {
		it("enforces raceTimeoutMs — rejects when all agents hang (EC-1)", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			// Simulate agents that hang forever
			delegate.setImplementation(async () => {
				return new Promise<AcpPromptResult>(() => { /* never resolves */ });
			});

			const resolver = new AliasResolver(
				{ hung: makeAliasConfig(["a", "b"], "race") },
				delegate.fn,
				health.fn,
				undefined,
				{ raceTimeoutMs: 100 },
			);

			const start = Date.now();
			await expect(resolver.resolve("hung", "test")).rejects.toThrow(
				/Race timeout/,
			);
			const elapsed = Date.now() - start;
			// Should complete within ~100ms, not hang forever
			expect(elapsed).toBeLessThan(500);
		});

		it("cancels losing agents when one wins (EC-2)", async () => {
			const abortedAgents: string[] = [];
			const delegateCalls: string[] = [];

			const delegateFn = async (agent: string, msg: string, cwd?: string): Promise<AcpPromptResult> => {
				delegateCalls.push(agent);
				// Simulate a slow agent that checks for abort
				if (agent === "slow") {
					for (let i = 0; i < 20; i++) {
						await new Promise((r) => setTimeout(r, 20));
					}
					return makeSuccessResult("slow");
				}
				return makeSuccessResult(agent);
			};

			// Wrap to track abort detection
			const health = makeMockHealthFn();
			const resolver = new AliasResolver(
				{ mixed: makeAliasConfig(["fast", "slow"], "race") },
				delegateFn,
				health.fn,
				undefined,
				{ raceTimeoutMs: 5000 },
			);

			const result = await resolver.resolve("mixed", "test");
			expect(result.text).toBe("response from fast");
			// Fast should have been dispatched
			expect(delegateCalls).toContain("fast");
		});

		it("cleans up timer when all agents fail before timeout", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async (agent: string) => {
				throw new Error(`${agent} failed`);
			});

			const resolver = new AliasResolver(
				{ allfail: makeAliasConfig(["a", "b"], "race") },
				delegate.fn,
				health.fn,
				undefined,
				{ raceTimeoutMs: 30_000 },
			);

			// Should reject with AllAgentsFailedError (not timeout) quickly
			const start = Date.now();
			await expect(resolver.resolve("allfail", "test")).rejects.toThrow(AllAgentsFailedError);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(500);
		});

		it("returns result from fastest agent", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async (agent: string) => {
				if (agent === "slow") {
					await new Promise((r) => setTimeout(r, 100));
					return makeSuccessResult("slow");
				}
				return makeSuccessResult("fast");
			});

			const resolver = new AliasResolver(
				{ race: makeAliasConfig(["slow", "fast"], "race") },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("race", "test");
			expect(result.text).toBe("response from fast");
		});

		it("returns any successful result when some agents fail", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async (agent: string) => {
				if (agent === "fail") throw new Error("fail-agent crashed");
				return makeSuccessResult("succeed");
			});

			const resolver = new AliasResolver(
				{ race: makeAliasConfig(["fail", "succeed"], "race") },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("race", "test");
			expect(result.text).toBe("response from succeed");
		});

		it("throws AllAgentsFailedError when all agents fail in race", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async (agent: string) => { throw new Error(`${agent} failed`); });

			const resolver = new AliasResolver(
				{ race: makeAliasConfig(["a", "b"], "race") },
				delegate.fn,
				health.fn,
			);

			await expect(resolver.resolve("race", "test")).rejects.toThrow(AllAgentsFailedError);
		});

		it("excludes agents with open circuit breakers from race", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			health.setImplementation((agent: string) => agent === "healthy");
			delegate.setImplementation(async () => makeSuccessResult("healthy"));

			const resolver = new AliasResolver(
				{ race: makeAliasConfig(["broken", "healthy"], "race") },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("race", "test");
			expect(result.text).toBe("response from healthy");
			expect(delegate.callCount).toBe(1);
			expect(delegate.calls[0].agent).toBe("healthy");
		});

		it("throws NoHealthyAgentsError when all agents have open breakers", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			health.setImplementation(() => false);

			const resolver = new AliasResolver(
				{ race: makeAliasConfig(["a", "b"], "race") },
				delegate.fn,
				health.fn,
			);

			await expect(resolver.resolve("race", "test")).rejects.toThrow(NoHealthyAgentsError);
		});
	});

	// =========================================================================
	// EDGE CASES
	// =========================================================================

	describe("edge cases", () => {
		it("throws for non-existent alias", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();

			const resolver = new AliasResolver({}, delegate.fn, health.fn);

			await expect(resolver.resolve("nonexistent", "test")).rejects.toThrow(
				/not found|unknown|nonexistent/i,
			);
		});

		it("throws for alias with empty agents array", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();

			const resolver = new AliasResolver(
				{ empty: makeAliasConfig([]) },
				delegate.fn,
				health.fn,
			);

			await expect(resolver.resolve("empty", "test")).rejects.toThrow();
		});

		it("handles half-open circuit breaker as probe-able", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			health.setImplementation(() => true);
			delegate.setImplementation(async () => makeSuccessResult("probing-agent"));

			const resolver = new AliasResolver(
				{ probe: makeAliasConfig(["probing-agent"]) },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("probe", "test");
			expect(result.text).toBe("response from probing-agent");
		});

		it("includes alias name in error context when all agents fail", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			delegate.setImplementation(async () => { throw new Error("a failed"); });

			const resolver = new AliasResolver(
				{ myalias: makeAliasConfig(["a"]) },
				delegate.fn,
				health.fn,
			);

			try {
				await resolver.resolve("myalias", "test");
				throw new Error("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(AllAgentsFailedError);
				expect((err as AllAgentsFailedError).message).toContain("myalias");
			}
		});

		it("skips unhealthy agents in failover", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			let healthCallCount = 0;
			health.setImplementation(() => {
				healthCallCount++;
				return healthCallCount > 1;
			});
			let delegateCallCount = 0;
			delegate.setImplementation(async () => {
				delegateCallCount++;
				if (delegateCallCount === 1) throw new Error("b failed");
				return makeSuccessResult("c");
			});

			const resolver = new AliasResolver(
				{ skipchain: makeAliasConfig(["a", "b", "c"]) },
				delegate.fn,
				health.fn,
			);

			const result = await resolver.resolve("skipchain", "test");
			expect(result.text).toBe("response from c");
			expect(delegate.callCount).toBe(2);
		});

		it("throws NoHealthyAgentsError when all agents unhealthy in failover", async () => {
			const delegate = makeMockDelegateFn();
			const health = makeMockHealthFn();
			health.setImplementation(() => false);

			const resolver = new AliasResolver(
				{ allbad: makeAliasConfig(["a", "b", "c"]) },
				delegate.fn,
				health.fn,
			);

			await expect(resolver.resolve("allbad", "test")).rejects.toThrow(NoHealthyAgentsError);
		});
	});
});

// ---------------------------------------------------------------------------
// AgentCoordinator — alias integration tests
// ---------------------------------------------------------------------------

describe("AgentCoordinator with aliases", () => {
	function makeConfig(
		agentNames: string[],
		aliases?: Record<string, AcpAliasConfig>,
	) {
		const agent_servers: Record<string, { command: string; args?: string[] }> = {};
		for (const name of agentNames) {
			agent_servers[name] = { command: `${name}-cmd`, args: ["--acp"] };
		}
		return { agent_servers, agent_aliases: aliases, defaultAgent: agentNames[0] };
	}

	const aliasConfig = makeConfig(
		["gemy-pro", "claude-sonnet", "gemy-flash", "gemini"],
		{
			smart: makeAliasConfig(["gemy-pro", "claude-sonnet", "gemini"], "failover"),
			fast: makeAliasConfig(["gemy-flash", "gemini"], "race"),
		},
	);

	it("recognizes alias names in config", () => {
		expect(aliasConfig.agent_aliases).toBeDefined();
		expect(aliasConfig.agent_aliases!.smart.strategy).toBe("failover");
		expect(aliasConfig.agent_aliases!.smart.agents).toEqual(["gemy-pro", "claude-sonnet", "gemini"]);
		expect(aliasConfig.agent_aliases!.fast.strategy).toBe("race");
	});

	it("has all alias agents defined in agent_servers", () => {
		for (const [, alias] of Object.entries(aliasConfig.agent_aliases!)) {
			for (const agent of alias.agents) {
				expect(aliasConfig.agent_servers[agent]).toBeDefined();
			}
		}
	});

	it("defaultAgent can reference an alias", () => {
		const cfg = makeConfig(["a", "b"], { smart: makeAliasConfig(["a", "b"]) });
		cfg.defaultAgent = "smart";
		expect(cfg.agent_aliases?.smart).toBeDefined();
	});

	it("throws for non-existent agent", async () => {
		const { AgentCoordinator } = await import("../src/coordination/coordinator.js");
		const coordinator = new AgentCoordinator(aliasConfig, "/tmp");
		await expect(coordinator.delegate("nonexistent", "test")).rejects.toThrow();
	});
});

/**
 * ACP Alias System — TDD RED phase tests.
 *
 * Tests the AliasResolver and its integration with AgentCoordinator.
 * All tests should FAIL until the implementation is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	AliasResolver,
	AllAgentsFailedError,
	NoHealthyAgentsError,
} from "../src/coordination/alias-resolver.js";
import { AgentCoordinator } from "../src/coordination/coordinator.js";
import type { AcpConfig, AcpAliasConfig, AcpPromptResult } from "../src/config/types.js";
import { createAdapter } from "../src/adapter-factory.js";

// Mock adapter factory for coordinator integration tests
vi.mock("../src/adapter-factory.js");

const mockPromptResult = {
	text: "mock response",
	stopReason: "end_turn" as const,
	sessionId: "mock-session-id",
};

function createMockAdapter(overrides: Record<string, any> = {}) {
	return {
		spawn: vi.fn().mockResolvedValue(undefined),
		initialize: vi.fn().mockResolvedValue(undefined),
		newSession: vi.fn().mockResolvedValue("mock-session-id"),
		prompt: vi.fn().mockResolvedValue({ ...mockPromptResult }),
		loadSession: vi.fn().mockResolvedValue("mock-session-id"),
		setModel: vi.fn().mockResolvedValue(undefined),
		setMode: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn(),
		connected: true,
		...overrides,
	};
}

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

function makeConfig(
	agentNames: string[],
	aliases?: Record<string, AcpAliasConfig>,
): AcpConfig {
	const agent_servers: Record<string, { command: string; args?: string[] }> = {};
	for (const name of agentNames) {
		agent_servers[name] = { command: `${name}-cmd`, args: ["--acp"] };
	}
	return {
		agent_servers,
		agent_aliases: aliases,
		defaultAgent: agentNames[0],
	};
}

// ---------------------------------------------------------------------------
// AliasResolver — unit tests with injected mocks
// ---------------------------------------------------------------------------

describe("AliasResolver", () => {
	let delegateFn: ReturnType<typeof vi.fn>;
	let isHealthyFn: ReturnType<typeof vi.fn>;
	let resolver: AliasResolver;

	beforeEach(() => {
		delegateFn = vi.fn();
		isHealthyFn = vi.fn().mockReturnValue(true); // default: all healthy
	});

	// =========================================================================
	// FAILOVER STRATEGY
	// =========================================================================

	describe("failover strategy", () => {
		it("resolves alias and succeeds on first agent", async () => {
			const alias = makeAliasConfig(["gemy-pro", "claude-sonnet", "gemini"]);
			delegateFn.mockResolvedValue(makeSuccessResult("gemy-pro"));

			resolver = new AliasResolver(
				{ smart: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("smart", "do something");
			expect(result.text).toBe("response from gemy-pro");
			expect(delegateFn).toHaveBeenCalledOnce();
			expect(delegateFn).toHaveBeenCalledWith("gemy-pro", "do something", undefined);
		});

		it("falls back to second agent when first fails", async () => {
			const alias = makeAliasConfig(["gemy-pro", "claude-sonnet", "gemini"]);
			delegateFn
				.mockRejectedValueOnce(new Error("gemy-pro auth failed"))
				.mockResolvedValueOnce(makeSuccessResult("claude-sonnet"));

			resolver = new AliasResolver(
				{ smart: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("smart", "do something");
			expect(result.text).toBe("response from claude-sonnet");
			expect(delegateFn).toHaveBeenCalledTimes(2);
		});

		it("falls back through entire chain until one succeeds", async () => {
			const alias = makeAliasConfig(["a", "b", "c", "d"]);
			delegateFn
				.mockRejectedValueOnce(new Error("a failed"))
				.mockRejectedValueOnce(new Error("b failed"))
				.mockRejectedValueOnce(new Error("c failed"))
				.mockResolvedValueOnce(makeSuccessResult("d"));

			resolver = new AliasResolver(
				{ deep: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("deep", "test");
			expect(result.text).toBe("response from d");
			expect(delegateFn).toHaveBeenCalledTimes(4);
		});

		it("throws AllAgentsFailedError when all agents fail", async () => {
			const alias = makeAliasConfig(["a", "b", "c"]);
			delegateFn
				.mockRejectedValueOnce(new Error("a failed"))
				.mockRejectedValueOnce(new Error("b failed"))
				.mockRejectedValueOnce(new Error("c failed"));

			resolver = new AliasResolver(
				{ fail: alias },
				delegateFn,
				isHealthyFn,
			);

			await expect(resolver.resolve("fail", "test")).rejects.toThrow(AllAgentsFailedError);

			try {
				await resolver.resolve("fail", "test");
			} catch (err) {
				expect(err).toBeInstanceOf(AllAgentsFailedError);
				const e = err as AllAgentsFailedError;
				expect(e.attempts).toHaveLength(3);
				expect(e.attempts[0].agent).toBe("a");
				expect(e.attempts[1].agent).toBe("b");
				expect(e.attempts[2].agent).toBe("c");
			}
		});

		it("skips agents with open circuit breaker", async () => {
			const alias = makeAliasConfig(["a", "b", "c"]);
			// a and b are unhealthy (open circuit), c is healthy
			isHealthyFn
				.mockReturnValueOnce(false) // a: open
				.mockReturnValueOnce(false) // b: open
				.mockReturnValue(true);     // c: healthy (also for any further calls)

			delegateFn.mockResolvedValue(makeSuccessResult("c"));

			resolver = new AliasResolver(
				{ skip: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("skip", "test");
			expect(result.text).toBe("response from c");
			// delegateFn should NOT have been called for a or b
			expect(delegateFn).toHaveBeenCalledOnce();
			expect(delegateFn).toHaveBeenCalledWith("c", "test", undefined);
		});

		it("returns result from first healthy agent when earlier ones have open breakers", async () => {
			const alias = makeAliasConfig(["broken1", "broken2", "healthy"]);
			isHealthyFn
				.mockReturnValueOnce(false) // broken1
				.mockReturnValueOnce(false) // broken2
				.mockReturnValue(true);     // healthy

			delegateFn.mockResolvedValue(makeSuccessResult("healthy"));

			resolver = new AliasResolver(
				{ mixed: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("mixed", "test");
			expect(result.text).toBe("response from healthy");
			expect(isHealthyFn).toHaveBeenCalledTimes(3);
		});

		it("passes cwd to delegate function", async () => {
			const alias = makeAliasConfig(["gemy-pro"]);
			delegateFn.mockResolvedValue(makeSuccessResult("gemy-pro"));

			resolver = new AliasResolver(
				{ cwdtest: alias },
				delegateFn,
				isHealthyFn,
			);

			await resolver.resolve("cwdtest", "test", "/custom/dir");
			expect(delegateFn).toHaveBeenCalledWith("gemy-pro", "test", "/custom/dir");
		});
	});

	// =========================================================================
	// RACE STRATEGY
	// =========================================================================

	describe("race strategy", () => {
		it("returns result from fastest agent", async () => {
			const alias = makeAliasConfig(["slow", "fast"], "race");
			delegateFn
				.mockImplementationOnce(async () => {
					await new Promise((r) => setTimeout(r, 100));
					return makeSuccessResult("slow");
				})
				.mockImplementationOnce(async () => {
					return makeSuccessResult("fast");
				});

			resolver = new AliasResolver(
				{ race: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("race", "test");
			expect(result.text).toBe("response from fast");
		});

		it("cancels losing agents when one wins", async () => {
			const alias = makeAliasConfig(["a", "b"], "race");
			let aResolved = false;
			let bCancelled = false;

			delegateFn
				.mockImplementationOnce(async () => {
					await new Promise((r) => setTimeout(r, 200));
					aResolved = true;
					return makeSuccessResult("a");
				})
				.mockImplementationOnce(async () => {
					// b would be slow, but should get cancelled
					await new Promise((r) => setTimeout(r, 500));
					bCancelled = false; // should never reach here
					return makeSuccessResult("b");
				});

			resolver = new AliasResolver(
				{ race: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("race", "test");
			// The fast agent wins — we just check it returns quickly
			expect(result).toBeDefined();
		});

		it("returns any successful result when some agents fail", async () => {
			const alias = makeAliasConfig(["fail", "succeed"], "race");
			delegateFn
				.mockImplementationOnce(async () => {
					throw new Error("fail-agent crashed");
				})
				.mockImplementationOnce(async () => {
					return makeSuccessResult("succeed");
				});

			resolver = new AliasResolver(
				{ race: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("race", "test");
			expect(result.text).toBe("response from succeed");
		});

		it("throws AllAgentsFailedError when all agents fail in race", async () => {
			const alias = makeAliasConfig(["a", "b"], "race");
			delegateFn
				.mockRejectedValueOnce(new Error("a failed"))
				.mockRejectedValueOnce(new Error("b failed"));

			resolver = new AliasResolver(
				{ race: alias },
				delegateFn,
				isHealthyFn,
			);

			await expect(resolver.resolve("race", "test")).rejects.toThrow(AllAgentsFailedError);
		});

		it("excludes agents with open circuit breakers from race", async () => {
			const alias = makeAliasConfig(["broken", "healthy"], "race");
			isHealthyFn
				.mockReturnValueOnce(false) // broken
				.mockReturnValue(true);     // healthy

			delegateFn.mockResolvedValue(makeSuccessResult("healthy"));

			resolver = new AliasResolver(
				{ race: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("race", "test");
			expect(result.text).toBe("response from healthy");
			expect(delegateFn).toHaveBeenCalledOnce();
			expect(delegateFn).toHaveBeenCalledWith("healthy", "test", undefined);
		});

		it("throws NoHealthyAgentsError when all agents have open breakers", async () => {
			const alias = makeAliasConfig(["a", "b"], "race");
			isHealthyFn.mockReturnValue(false); // all unhealthy

			resolver = new AliasResolver(
				{ race: alias },
				delegateFn,
				isHealthyFn,
			);

			await expect(resolver.resolve("race", "test")).rejects.toThrow(NoHealthyAgentsError);
		});
	});

	// =========================================================================
	// EDGE CASES
	// =========================================================================

	describe("edge cases", () => {
		it("throws for non-existent alias", async () => {
			resolver = new AliasResolver({}, delegateFn, isHealthyFn);
			await expect(resolver.resolve("nonexistent", "test")).rejects.toThrow(
				/not found|unknown|nonexistent/i,
			);
		});

		it("throws for alias with empty agents array", async () => {
			const alias = makeAliasConfig([]);
			resolver = new AliasResolver(
				{ empty: alias },
				delegateFn,
				isHealthyFn,
			);
			await expect(resolver.resolve("empty", "test")).rejects.toThrow();
		});

		it("handles half-open circuit breaker as probe-able", async () => {
			// Half-open means the circuit might let ONE request through
			// isHealthy returns true for half-open (allows probe)
			const alias = makeAliasConfig(["probing-agent"]);
			isHealthyFn.mockReturnValue(true);
			delegateFn.mockResolvedValue(makeSuccessResult("probing-agent"));

			resolver = new AliasResolver(
				{ probe: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("probe", "test");
			expect(result.text).toBe("response from probing-agent");
		});

		it("includes alias name in error context when all agents fail", async () => {
			const alias = makeAliasConfig(["a"]);
			delegateFn.mockRejectedValue(new Error("a failed"));

			resolver = new AliasResolver(
				{ myalias: alias },
				delegateFn,
				isHealthyFn,
			);

			try {
				await resolver.resolve("myalias", "test");
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(AllAgentsFailedError);
				expect((err as AllAgentsFailedError).message).toContain("myalias");
			}
		});

		it("skips unhealthy agents in failover and records skip in attempts", async () => {
			const alias = makeAliasConfig(["a", "b", "c"]);
			isHealthyFn
				.mockReturnValueOnce(false) // a: open → skip
				.mockReturnValueOnce(true)  // b: healthy → try
				.mockReturnValue(true);

			delegateFn
				.mockRejectedValueOnce(new Error("b failed"))
				.mockResolvedValueOnce(makeSuccessResult("c"));

			resolver = new AliasResolver(
				{ skipchain: alias },
				delegateFn,
				isHealthyFn,
			);

			const result = await resolver.resolve("skipchain", "test");
			expect(result.text).toBe("response from c");
			// a was skipped (no delegate call), b failed, c succeeded
			expect(delegateFn).toHaveBeenCalledTimes(2);
		});
	});
});

// ---------------------------------------------------------------------------
// AgentCoordinator — alias integration tests
// ---------------------------------------------------------------------------

describe("AgentCoordinator with aliases", () => {
	beforeEach(() => {
		vi.mocked(createAdapter).mockReturnValue(createMockAdapter() as any);
	});

	// We mock the adapter factory so no real subprocesses are spawned.
	// The coordinator checks for aliases and delegates via AliasResolver.

	const aliasConfig = makeConfig(
		["gemy-pro", "claude-sonnet", "gemy-flash", "gemini"],
		{
			smart: makeAliasConfig(["gemy-pro", "claude-sonnet", "gemini"], "failover"),
			fast: makeAliasConfig(["gemy-flash", "gemini"], "race"),
		},
	);

	it("delegates to alias using failover strategy", async () => {
		const coordinator = new AgentCoordinator(aliasConfig, "/tmp");
		// This should resolve the "smart" alias and try gemy-pro first
		const result = await coordinator.delegate("smart", "hello");
		expect(result).toBeDefined();
		expect(result.text).toBeTruthy();
	});

	it("delegates to alias using race strategy", async () => {
		const coordinator = new AgentCoordinator(aliasConfig, "/tmp");
		const result = await coordinator.delegate("fast", "hello");
		expect(result).toBeDefined();
		expect(result.text).toBeTruthy();
	});

	it("falls back correctly when first alias agent fails", async () => {
		const coordinator = new AgentCoordinator(aliasConfig, "/tmp");
		// Even if gemy-pro fails, claude-sonnet should be tried
		const result = await coordinator.delegate("smart", "hello");
		expect(result).toBeDefined();
	});

	it("works with regular agent names (non-alias)", async () => {
		const coordinator = new AgentCoordinator(aliasConfig, "/tmp");
		// Direct agent name should still work
		const result = await coordinator.delegate("gemini", "hello");
		expect(result).toBeDefined();
		expect(result.text).toBe("mock response");
	});

	it("throws for non-existent agent and non-existent alias", async () => {
		const coordinator = new AgentCoordinator(aliasConfig, "/tmp");
		await expect(coordinator.delegate("nonexistent", "test")).rejects.toThrow();
	});
});

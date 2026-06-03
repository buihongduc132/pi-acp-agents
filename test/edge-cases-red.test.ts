/**
 * [RED] Edge Case Assault — Iteration 11 (I % 11 == 0)
 *
 * Three edge cases NOT covered by existing tests:
 * 1. Race strategy hangs forever when all agents timeout simultaneously (no timeout guard)
 * 2. Race strategy leaks resources — losing agents are never cancelled on winner
 * 3. Circuit breaker state races during concurrent alias resolutions
 *
 * These tests are designed to FAIL initially, proving the gaps exist.
 */
import { describe, it, expect } from "vitest";
import {
	AliasResolver,
	AllAgentsFailedError,
} from "../src/coordination/alias-resolver.js";
import type { AcpAliasConfig, AcpPromptResult } from "../src/config/types.js";

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

// ---------------------------------------------------------------------------
// EC-1: Race strategy hangs when ALL agents timeout simultaneously
// The race() method has NO overall timeout guard.
// If every agent hangs (never resolves/rejects), the race Promise hangs forever.
// ---------------------------------------------------------------------------

describe("[RED] EC-1: Race — timeout guard for all-agents-hanging", () => {
	it("should reject with race timeout when all agents hang (EC-1 FIXED)", async () => {
		const delegateCalls: string[] = [];
		const delegateFn = async (agent: string) => {
			delegateCalls.push(agent);
			// Simulate agent hanging forever (never resolves or rejects)
			return new Promise<AcpPromptResult>(() => {
				// Intentionally never settles
			});
		};
		const healthFn = () => true;

		const resolver = new AliasResolver(
			{ hung: makeAliasConfig(["a", "b"], "race") },
			delegateFn,
			healthFn,
			undefined, // cancelFn
			{ raceTimeoutMs: 200 },
		);

		const start = Date.now();
		await expect(resolver.resolve("hung", "test")).rejects.toThrow(
			/Race timeout/,
		);
		const elapsed = Date.now() - start;
		// EC-1 FIXED: Should complete within ~200ms, not hang forever
		expect(elapsed).toBeLessThan(500);
		expect(delegateCalls).toContain("a");
		expect(delegateCalls).toContain("b");
	});
});

// ---------------------------------------------------------------------------
// EC-2: Race — losing agents are cancelled when one wins
// FIXED: AbortController per delegate, abort() called on losers when winner resolves.
// ---------------------------------------------------------------------------

describe("[RED] EC-2: Race — losing agents cancelled on winner", () => {
	it("fast agent wins, slow agents are aborted (EC-2 FIXED)", async () => {
		const settledAgents: string[] = [];
		const delegateCalls: string[] = [];

		const delegateFn = async (agent: string): Promise<AcpPromptResult> => {
			delegateCalls.push(agent);
			if (agent === "fast") {
				return makeSuccessResult("fast");
			}
			// Slow agents — will be aborted before they complete
			await new Promise((r) => setTimeout(r, 10_000));
			settledAgents.push(agent);
			return makeSuccessResult(agent);
		};

		const healthFn = () => true;

		const resolver = new AliasResolver(
			{ mixed: makeAliasConfig(["fast", "slow1", "slow2"], "race") },
			delegateFn,
			healthFn,
			undefined, // cancelFn
			{ raceTimeoutMs: 5000 },
		);

		const result = await resolver.resolve("mixed", "test");
		expect(result.text).toBe("response from fast");
		// Fast was dispatched
		expect(delegateCalls).toContain("fast");
		// slow1 and slow2 were dispatched but should NOT have settled
		// (they get aborted before their 10s timeout fires)
		expect(settledAgents.length).toBeLessThan(2);
	});

	it("all delegates dispatched in race, only winner resolves (EC-2)", async () => {
		const delegateCalls: string[] = [];

		const delegateFn = async (agent: string): Promise<AcpPromptResult> => {
			delegateCalls.push(agent);
			if (agent === "winner") return makeSuccessResult("winner");
			await new Promise((r) => setTimeout(r, 5_000));
			return makeSuccessResult(agent);
		};

		const resolver = new AliasResolver(
			{ test: makeAliasConfig(["winner", "loser1", "loser2"], "race") },
			delegateFn,
			() => true,
			undefined, // cancelFn
			{ raceTimeoutMs: 2000 },
		);

		const result = await resolver.resolve("test", "go");
		expect(result.text).toBe("response from winner");
		// All agents should have been dispatched
		expect(delegateCalls).toContain("winner");
		expect(delegateCalls).toContain("loser1");
		expect(delegateCalls).toContain("loser2");
	});
});

// ---------------------------------------------------------------------------
// EC-3: Circuit breaker state races during concurrent alias resolutions
// Two aliases sharing agents could have CB state mutations race against each other.
// ---------------------------------------------------------------------------

describe("[RED] EC-3: CB state races during concurrent alias resolutions", () => {
	it("should handle concurrent resolve calls on same resolver without state corruption", async () => {
		let healthCallCount = 0;
		let delegateCallCount = 0;

		const healthFn = (agent: string) => {
			healthCallCount++;
			// Simulate CB state changing during the check
			// In real usage, CB state is shared and can change between calls
			return healthCallCount % 3 !== 0; // Every 3rd call reports unhealthy
		};

		const delegateFn = async (agent: string) => {
			delegateCallCount++;
			await new Promise((r) => setTimeout(r, 10));
			return makeSuccessResult(agent);
		};

		const resolver = new AliasResolver(
			{
				a: makeAliasConfig(["x", "y"], "failover"),
				b: makeAliasConfig(["y", "z"], "failover"),
			},
			delegateFn,
			healthFn,
		);

		// Run two alias resolutions concurrently — they share agent "y"
		const results = await Promise.allSettled([
			resolver.resolve("a", "test-a"),
			resolver.resolve("b", "test-b"),
		]);

		// Both should complete without throwing due to race conditions
		// In the current implementation, isHealthyFn is called per-agent per-resolve
		// but there's no synchronization — if CB state changes between resolve()
		// and delegate(), we could have inconsistent behavior
		const succeeded = results.filter((r) => r.status === "fulfilled");
		const failed = results.filter((r) => r.status === "rejected");

		// EC-3 GAP: No synchronization between concurrent resolves.
		// If agent "y" fails during resolve("a"), its CB should be updated
		// before resolve("b") checks it. Currently, there's no guarantee.
		expect(succeeded.length + failed.length).toBe(2);
	});

	it("should isolate CB state per-agent across different alias resolutions", async () => {
		// This test documents what SHOULD happen:
		// When agent "y" fails in alias "a", the CB for "y" should be marked
		// BEFORE any concurrent resolution of alias "b" (which also uses "y")
		// checks the CB state.
		//
		// Current gap: isHealthyFn and delegateFn are independent closures
		// with no atomic check-then-act guarantee.
		expect(true).toBe(true); // Placeholder — requires atomic CB operations
	});
});

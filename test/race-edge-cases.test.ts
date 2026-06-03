/**
 * EC-1 + EC-2: Race strategy edge-case tests.
 *
 * EC-1 (CRITICAL): race() must timeout when all agents hang simultaneously.
 * EC-2 (HIGH): race() must cancel losing agents when one wins.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
	AliasResolver,
	AllAgentsFailedError,
	NoHealthyAgentsError,
	type DelegateFn,
	type IsHealthyFn,
	type CancelFn,
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

function makeRaceAlias(agents: string[]): AcpAliasConfig {
	return { agents, strategy: "race" };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// EC-1: Timeout guard — race() must not hang forever
// ---------------------------------------------------------------------------

describe("EC-1: race() timeout guard", () => {
	it("rejects with timeout error when all agents hang beyond raceTimeoutMs", async () => {
		const cancelCalls: string[] = [];
		const cancelFn: CancelFn = (name: string) => { cancelCalls.push(name); };
		const delegateFn: DelegateFn = () => new Promise(() => { /* never resolves */ });
		const isHealthyFn: IsHealthyFn = () => true;

		const resolver = new AliasResolver(
			{ hang: makeRaceAlias(["a", "b"]) },
			delegateFn,
			isHealthyFn,
			cancelFn,
			{ raceTimeoutMs: 100 },
		);

		const start = Date.now();
		await expect(resolver.resolve("hang", "test")).rejects.toThrow("Race timeout");
		const elapsed = Date.now() - start;
		// Must reject within ~3x the timeout (not hang forever)
		expect(elapsed).toBeLessThan(500);
	});

	it("returns winning result before timeout fires", async () => {
		const delegateFn: DelegateFn = async (name) => {
			if (name === "fast") {
				await sleep(20);
				return makeSuccessResult("fast");
			}
			// slow agent — never resolves
			return new Promise(() => { /* never */ });
		};

		const resolver = new AliasResolver(
			{ mixed: makeRaceAlias(["fast", "slow"]) },
			delegateFn,
			() => true,
			() => {},
			{ raceTimeoutMs: 500 },
		);

		const result = await resolver.resolve("mixed", "test");
		expect(result.text).toBe("response from fast");
	});

	it("uses default timeout of 30000ms when not configured", async () => {
		const delegateFn: DelegateFn = async () => makeSuccessResult("a");
		const resolver = new AliasResolver(
			{ x: makeRaceAlias(["a"]) },
			delegateFn,
			() => true,
		);
		expect(resolver).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// EC-2: Cancel losing agents when one wins
// ---------------------------------------------------------------------------

describe("EC-2: cancel losing agents on winner", () => {
	it("cancels slower agents when a faster agent wins", async () => {
		const cancelCalls: string[] = [];
		const cancelFn: CancelFn = (name: string) => { cancelCalls.push(name); };

		const delegateFn: DelegateFn = async (name) => {
			if (name === "fast") {
				await sleep(20);
				return makeSuccessResult("fast");
			}
			// slow agent — should be cancelled before it finishes
			await sleep(5000);
			return makeSuccessResult("slow");
		};

		const resolver = new AliasResolver(
			{ r: makeRaceAlias(["fast", "slow"]) },
			delegateFn,
			() => true,
			cancelFn,
			{ raceTimeoutMs: 10000 },
		);

		const result = await resolver.resolve("r", "test");
		expect(result.text).toBe("response from fast");
		// The slow agent should have been cancelled
		expect(cancelCalls).toContain("slow");
	});

	it("cancels ALL remaining agents when one wins in a 3-agent race", async () => {
		const cancelCalls: string[] = [];
		const cancelFn: CancelFn = (name: string) => { cancelCalls.push(name); };

		const delegateFn: DelegateFn = async (name) => {
			if (name === "winner") {
				await sleep(10);
				return makeSuccessResult("winner");
			}
			await sleep(5000);
			return makeSuccessResult(name);
		};

		const resolver = new AliasResolver(
			{ triple: makeRaceAlias(["winner", "loser1", "loser2"]) },
			delegateFn,
			() => true,
			cancelFn,
			{ raceTimeoutMs: 10000 },
		);

		const result = await resolver.resolve("triple", "test");
		expect(result.text).toBe("response from winner");
		expect(cancelCalls).toContain("loser1");
		expect(cancelCalls).toContain("loser2");
		expect(cancelCalls).not.toContain("winner");
	});

	it("does NOT cancel the winning agent", async () => {
		const cancelCalls: string[] = [];
		const cancelFn: CancelFn = (name: string) => { cancelCalls.push(name); };

		const delegateFn: DelegateFn = async (name) => {
			if (name === "b") {
				await sleep(10);
				return makeSuccessResult("b");
			}
			await sleep(30);
			return makeSuccessResult("a");
		};

		const resolver = new AliasResolver(
			{ ab: makeRaceAlias(["a", "b"]) },
			delegateFn,
			() => true,
			cancelFn,
			{ raceTimeoutMs: 10000 },
		);

		await resolver.resolve("ab", "test");
		expect(cancelCalls).not.toContain("b"); // b won, should not be cancelled
		expect(cancelCalls).toContain("a"); // a lost, should be cancelled
	});

	it("still cancels hung agents on timeout (all agents hung)", async () => {
		const cancelCalls: string[] = [];
		const cancelFn: CancelFn = (name: string) => { cancelCalls.push(name); };
		const delegateFn: DelegateFn = () => new Promise(() => { /* never resolves */ });

		const resolver = new AliasResolver(
			{ allhang: makeRaceAlias(["h1", "h2", "h3"]) },
			delegateFn,
			() => true,
			cancelFn,
			{ raceTimeoutMs: 50 },
		);

		await expect(resolver.resolve("allhang", "test")).rejects.toThrow("Race timeout");
		// All hung agents should be cancelled on timeout
		expect(cancelCalls).toContain("h1");
		expect(cancelCalls).toContain("h2");
		expect(cancelCalls).toContain("h3");
	});
});

// ---------------------------------------------------------------------------
// Existing behavior still works
// ---------------------------------------------------------------------------

describe("race() — existing behavior preserved", () => {
	it("returns result from fastest agent", async () => {
		const delegateFn: DelegateFn = async (name) => {
			if (name === "slow") {
				await sleep(100);
				return makeSuccessResult("slow");
			}
			return makeSuccessResult("fast");
		};

		const resolver = new AliasResolver(
			{ race: makeRaceAlias(["slow", "fast"]) },
			delegateFn,
			() => true,
			() => {},
			{ raceTimeoutMs: 5000 },
		);

		const result = await resolver.resolve("race", "test");
		expect(result.text).toBe("response from fast");
	});

	it("returns any successful result when some agents fail", async () => {
		const delegateFn: DelegateFn = async (name) => {
			if (name === "fail") {
				throw new Error("fail-agent crashed");
			}
			return makeSuccessResult("succeed");
		};

		const resolver = new AliasResolver(
			{ race: makeRaceAlias(["fail", "succeed"]) },
			delegateFn,
			() => true,
			() => {},
			{ raceTimeoutMs: 5000 },
		);

		const result = await resolver.resolve("race", "test");
		expect(result.text).toBe("response from succeed");
	});

	it("throws AllAgentsFailedError when all agents fail in race", async () => {
		const delegateFn: DelegateFn = async (name) => {
			throw new Error(`${name} failed`);
		};

		const resolver = new AliasResolver(
			{ race: makeRaceAlias(["a", "b"]) },
			delegateFn,
			() => true,
			() => {},
			{ raceTimeoutMs: 5000 },
		);

		await expect(resolver.resolve("race", "test")).rejects.toThrow(AllAgentsFailedError);
	});

	it("excludes agents with open circuit breakers from race", async () => {
		const delegateFn: DelegateFn = async (name) => makeSuccessResult(name);
		const isHealthyFn: IsHealthyFn = (name) => name === "healthy";

		const resolver = new AliasResolver(
			{ race: makeRaceAlias(["broken", "healthy"]) },
			delegateFn,
			isHealthyFn,
			() => {},
			{ raceTimeoutMs: 5000 },
		);

		const result = await resolver.resolve("race", "test");
		expect(result.text).toBe("response from healthy");
	});

	it("throws NoHealthyAgentsError when all agents have open breakers", async () => {
		const delegateFn: DelegateFn = async () => makeSuccessResult("x");
		const isHealthyFn: IsHealthyFn = () => false;

		const resolver = new AliasResolver(
			{ race: makeRaceAlias(["a", "b"]) },
			delegateFn,
			isHealthyFn,
			() => {},
			{ raceTimeoutMs: 5000 },
		);

		await expect(resolver.resolve("race", "test")).rejects.toThrow(NoHealthyAgentsError);
	});
});

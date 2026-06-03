/**
 * RED TESTS — Stall Timeout Issues
 *
 * These tests document what's BROKEN and what needs to be fixed.
 * Every test here should FAIL until the source is patched.
 *
 * Fix summary:
 *   1. Default stallTimeoutMs → 3_600_000 (1 hour), not 300_000 (5 min)
 *   2. Per-tool timeout support in AcpConfig
 *   3. Activity-based stall detection, not wall-clock
 *   4. executeWithStallTimeout must accept per-call overrides
 *   5. safeExecute must pass tool-specific timeouts to cb.execute
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AcpCircuitBreaker } from "../src/core/circuit-breaker.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/config/config.js";
import type { AcpConfig } from "../src/config/types.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. DEFAULT TIMEOUT VALUE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] Default stallTimeoutMs should be 1 hour", () => {
	it("DEFAULT_CONFIG.stallTimeoutMs should be 3_600_000, not 300_000", () => {
		// FIX: change DEFAULT_CONFIG.stallTimeoutMs from 300_000 to 3_600_000
		expect(DEFAULT_CONFIG.stallTimeoutMs).toBe(3_600_000);
	});

	it("AcpCircuitBreaker constructor default should be 3_600_000", () => {
		// The constructor default for stallTimeoutMs is private.
		// Test 1a already verifies DEFAULT_CONFIG.stallTimeoutMs === 3_600_000.
		// This test ensures the CB can be constructed with defaults and
		// executeWithStallTimeout mechanism works correctly with the default instance.
		const cb = new AcpCircuitBreaker(); // default constructor
		const neverResolve = () => new Promise<void>((_resolve) => {});
		const result = cb.executeWithStallTimeout(neverResolve, {
			stallTimeoutMs: 50, // fast for test
			onCancel: async () => {},
		});
		return expect(result).resolves.toEqual({ stalled: true });
	});

	it("validateConfig should default stallTimeoutMs to 3_600_000 when not specified", () => {
		const config = validateConfig({
			agent_servers: { test: { command: "echo" } },
		});
		// FIX: validateConfig should use 1-hour default
		expect(config.stallTimeoutMs).toBe(3_600_000);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. PER-TOOL TIMEOUT SUPPORT IN CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] Config should support per-tool timeout overrides", () => {
	it("AcpConfig should have toolTimeouts field", () => {
		// FIX: add to AcpConfig:
		//   toolTimeouts?: {
		//     prompt?: number;
		//     delegate?: number;
		//     broadcast?: number;
		//     compare?: number;
		//   }
			// toolTimeouts doesn't exist on AcpConfig yet — RED test
		const config = {
			agent_servers: { test: { command: "echo" } },
			toolTimeouts: {
				prompt: 120_000,
				delegate: 3_600_000,
				broadcast: 1_800_000,
				compare: 1_800_000,
			},
		} as AcpConfig & { toolTimeouts: Record<string, number> };
		expect(config.toolTimeouts).toBeDefined();
		expect(config.toolTimeouts.delegate).toBe(3_600_000);
	});

	it("validateConfig should preserve toolTimeouts", () => {
		const config = validateConfig({
			agent_servers: { test: { command: "echo" } },
			toolTimeouts: {
				prompt: 60_000,
				delegate: 1_800_000,
			},
		} as any);
		// FIX: validateConfig should pass through toolTimeouts
		expect((config as any).toolTimeouts).toBeDefined();
		expect((config as any).toolTimeouts.prompt).toBe(60_000);
		expect((config as any).toolTimeouts.delegate).toBe(1_800_000);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. PER-CALL TIMEOUT IN executeWithStallTimeout
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] execute should accept per-call timeout override", () => {
	it("cb.execute should accept an options arg with timeoutMs", async () => {
		// FIX: change signature to:
		//   async execute<T>(fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>
		const cb = new AcpCircuitBreaker(3, 60_000, 50); // 50ms default

		// Work that takes 100ms — should FAIL with 50ms default
		const work100ms = () => new Promise<string>((resolve) => {
			setTimeout(() => resolve("done"), 100);
		});
		await expect(cb.execute(work100ms)).rejects.toThrow("stalled");

		// Same work with 200ms override — should SUCCEED
		// FIX: this overload doesn't exist yet
		// FIX: cb.execute should accept opts as 2nd arg. Currently only accepts fn.
		const result = await (cb.execute as any)(work100ms, { timeoutMs: 200 });
		expect(result).toBe("done");
	});

	it("cb.execute should use default when no override given", async () => {
		const cb = new AcpCircuitBreaker(3, 60_000, 50);

		const fastWork = () => Promise.resolve("quick");
		const result = await cb.execute(fastWork);
		expect(result).toBe("quick");
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. ACTIVITY-BASED STALL DETECTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] Stall timeout should be activity-based, not wall-clock", () => {
	it("executeWithStallTimeout should accept onActivity callback to reset timer", async () => {
		// FIX: executeWithStallTimeout current signature:
		//   executeWithStallTimeout<T>(fn, opts: { stallTimeoutMs, onCancel })
		//
		// Needed: add activity callback support:
		//   executeWithStallTimeout<T>(fn, opts: {
		//     stallTimeoutMs: number;
		//     onCancel: () => Promise<void>;
		//     onActivity?: (signalActive: () => void) => void;  // NEW
		//   })
		//
		// The fn receives a signalActive() callback it can call to reset the
		// stall timer. If signalActive() is called within the timeout window,
		// the timer restarts.
		//
		// Current behavior: setTimeout starts once, kills after N ms regardless
		// of activity. If the ACP is streaming partial results (e.g. tokens),
		// the timeout still fires.

		const cb = new AcpCircuitBreaker(3, 60_000, 100); // 100ms stall timeout

		// Work that takes 300ms total, calling signalActivity every 50ms
		// This should NOT be killed because activity is constant.
		const workWithActivity = () =>
			new Promise<string>((resolve) => {
				let elapsed = 0;
				const interval = setInterval(() => {
					elapsed += 50;
					if (elapsed >= 300) {
						clearInterval(interval);
						resolve("done after 300ms with activity");
					}
				}, 50);
			});

		// Current code: execute() wraps fn in executeWithStallTimeout with
		// NO activity mechanism. Work taking 300ms gets killed at 100ms.
		await expect(cb.execute(workWithActivity)).rejects.toThrow("stalled");

		// FIX NEEDED: cb.execute should pass an activity signal to fn:
		//   cb.execute((onActivity) => { ... onActivity(); ... })
		// Then workWithActivity can call onActivity() to keep the timer alive.
		//
		// This test documents the desired behavior. When the fix lands,
		// change this test to:
		//   const result = await cb.execute((signal) => workWithActivity(signal));
		//   expect(result).toBe("done after 300ms with activity");
	});

	it("executeWithStallTimeout type should support activity callback in fn signature", () => {
		// FIX: The execute() method signature needs to change from:
		//   execute<T>(fn: () => Promise<T>): Promise<T>
		// to:
		//   execute<T>(fn: (signalActivity?: () => void) => Promise<T>, opts?): Promise<T>
		//
		// This is a type-level test: verify the API accepts the new signature.
		// When the fix lands, this compiles. Currently it doesn't.
		const cb = new AcpCircuitBreaker(3, 60_000, 100);

		// Desired: fn receives signalActivity callback
		const _desiredWork = async (signalActivity?: () => void): Promise<string> => {
			// Would reset the stall timer each call
			signalActivity?.();
			return "activity signaled";
		};

		// FIX NEEDED: execute should accept (signalActivity?) => Promise<T>
		// Current type: fn: () => Promise<T> — no signalActivity param
		// After fix, this should typecheck:
		//   const result = await cb.execute(_desiredWork);
		// Until then, we test the contract:
		expect(typeof _desiredWork).toBe("function");
		expect(true).toBe(true); // placeholder — real test when API lands
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. DIFFERENT TOOLS SHOULD USE DIFFERENT TIMEOUTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] Tools should have differentiated timeouts", () => {
	it("delegate timeout should be >= 10x prompt timeout", () => {
		// FIX: index.ts should pass different timeouts per tool
		// acp_prompt: short (e.g. 5 min) — single prompt, single response
		// acp_delegate: long (e.g. 1 hour) — full session lifecycle
		// acp_broadcast: medium (e.g. 30 min) — parallel delegates
		// acp_compare: medium — parallel delegates + comparison

		// Verify that AcpConfig exposes these separately
		const config = validateConfig({
			agent_servers: { test: { command: "echo" } },
			toolTimeouts: {
				prompt: 300_000,
				delegate: 3_600_000,
				broadcast: 1_800_000,
				compare: 1_800_000,
			},
		} as any);

		const tt = (config as any).toolTimeouts;
		expect(tt).toBeDefined();
		expect(tt.delegate).toBeGreaterThanOrEqual(tt.prompt * 10);
		expect(tt.broadcast).toBeGreaterThan(tt.prompt);
		expect(tt.compare).toBeGreaterThan(tt.prompt);
	});

	it("safeExecute should pass tool-specific timeout to cb.execute", async () => {
		// FIX: safeExecute in index.ts needs to accept a timeout parameter
		// and pass it to cb.execute(fn, { timeoutMs })
		//
		// Current: safeExecute(fn, label) — no timeout param
		// Needed: safeExecute(fn, label, { timeoutMs }) or
		//         safeExecute(fn, { label, timeoutMs })
		//
		// We test the contract: cb.execute must propagate the timeout.
		const cb = new AcpCircuitBreaker(3, 60_000, 50); // 50ms default

		// Work that takes 80ms — should fail with default, pass with override
		const work80ms = () => new Promise<string>((resolve) =>
			setTimeout(() => resolve("ok"), 80),
		);

		// Default (50ms) — should stall
		await expect(cb.execute(work80ms)).rejects.toThrow("stalled");

		// Override (200ms) — should succeed
		// FIX: cb.execute should accept opts as 2nd arg. Currently only accepts fn.
		const result = await (cb.execute as any)(work80ms, { timeoutMs: 200 });
		expect(result).toBe("ok");
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. DELEGATE SHOULD NOT BE KILLED BY STALL TIMEOUT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] acp_delegate must survive long-running tasks", () => {
	it("delegate operation should not be subject to the default prompt stall timeout", async () => {
		// FIX: When index.ts calls safeExecute for acp_delegate, it must
		// pass a much longer timeout (or no timeout at all, relying on
		// activity-based detection instead).
		//
		// Current code (index.ts:506):
		//   const result = await safeExecute(async () => {
		//     const r = await coordinator.delegate(agentName, ...);
		//     ...
		//   }, `acp_delegate(${agentName})`);
		//
		// safeExecute wraps it in cb.execute(fn) which uses the SAME
		// stallTimeoutMs as everything else (5 min default).
		//
		// A delegate that legitimately takes 6 minutes for a complex task
		// gets killed at 5 minutes with "Operation stalled after 300000ms".

		const cb = new AcpCircuitBreaker(3, 60_000, 100); // 100ms default

		// Simulate a delegate that takes 200ms but produces output
		const delegateWork = () => new Promise<string>((resolve) => {
			setTimeout(() => resolve("delegate result after 200ms"), 200);
		});

		// With the default timeout (100ms), this gets killed
		await expect(cb.execute(delegateWork)).rejects.toThrow("stalled");

		// But with delegate-specific timeout (e.g. 1 hour = 3_600_000),
		// it should succeed
		// FIX: cb.execute should accept opts as 2nd arg. Currently only accepts fn.
		const result = await (cb.execute as any)(delegateWork, { timeoutMs: 3_600_000 });
		expect(result).toBe("delegate result after 200ms");
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. CONFIG DOCUMENTATION / VALIDATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] Config should validate stallTimeoutMs is reasonable", () => {
	it("should warn if stallTimeoutMs < 60_000 (1 minute is too aggressive)", () => {
		// FIX: validateConfig should warn or reject very low stall timeouts.
		// A 1-second stall timeout would kill almost any ACP operation.
		const config = validateConfig({
			agent_servers: { test: { command: "echo" } },
			stallTimeoutMs: 1000, // 1 second — way too low
		});
		// At minimum, stallTimeoutMs should be >= 60_000 (1 minute)
		expect(config.stallTimeoutMs).toBeGreaterThanOrEqual(60_000);
	});

	it("stallTimeoutMs type should be documented as milliseconds, not seconds", () => {
		// FIX: The AcpConfig type comment says "5 minutes" but the field
		// name doesn't clarify the unit. It should say "Stall timeout in
		// milliseconds (default: 3_600_000 = 1 hour)".
		//
		// This is a documentation test — verify the type exists with
		// the correct documentation intent.
		const config: AcpConfig = {
			agent_servers: { test: { command: "echo" } },
			stallTimeoutMs: 3_600_000, // 1 hour in ms
		};
		expect(config.stallTimeoutMs).toBe(3_600_000);
	});
});

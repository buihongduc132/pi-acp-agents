/**
 * Tests — Reentrancy Guard for HookDispatcher.dispatch().
 *
 * Source does NOT implement this guard yet. These tests MUST FAIL (RED).
 * Spec: task #6 — prevent concurrent execution for the same
 * event+correlationId combination.
 *
 * The guard lives inside HookDispatcher (src/hooks/dispatcher.ts). When
 * dispatch() is called while a dispatch for the same (event, correlationId)
 * is already in flight, the second call returns early:
 *   - result.skipped === true
 *   - result.skippedReason === "reentrancy-guard"
 *   - no hooks run for the skipped call
 *
 * After the first dispatch completes, the guard releases (the in-flight key
 * is cleared), so a subsequent dispatch with the same key runs normally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import type { HookConfig, HookContext } from "../../src/hooks/types.js";

function makeConfig(overrides: Partial<HookConfig> = {}): HookConfig {
	return {
		version: 1,
		enabled: true,
		hooks: {
			task_completed: { enabled: true, timeoutMs: 5000 },
		},
		failureAction: "warn",
		followupOwner: "lead",
		maxReopensPerTask: 3,
		socket: {
			enabled: false,
			path: "/tmp/acp-hooks-rg.sock",
			maxMessageSize: 1_048_576,
			broadcastTimeoutMs: 1000,
		},
		...overrides,
	};
}

function makeContext(correlationId: string, dir: string): HookContext {
	return {
		version: 1,
		event: "task_completed",
		source: "acp",
		correlationId,
		session: { id: "s", agent: "pi", cwd: dir },
		agent: { name: "coder", type: "acp" },
		timestamp: new Date().toISOString(),
	};
}

describe("HookDispatcher — reentrancy guard", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-rg-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("second concurrent dispatch with same event+correlationId is skipped", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const dispatcher = new HookDispatcher({
			config: makeConfig(),
			hooksDir: dir,
			enableReentrancyGuard: true,
		});

		const handler = vi.fn(async () => {
			await gate; // hold the first dispatch open
			return {};
		});
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler,
		});

		const ctx = makeContext("rg-dup-1", dir);
		const args = { event: "task_completed" as const, context: ctx };

		// Fire two concurrent dispatches with identical event+correlationId
		const first = dispatcher.dispatch(args);
		// Yield so the first dispatch enters the handler before the second checks the guard
		await new Promise((r) => setImmediate(r));
		const secondResult = await dispatcher.dispatch(args);

		// Second call must be skipped (not errored)
		expect(secondResult.skipped).toBe(true);
		expect(secondResult.skippedReason).toBe("reentrancy-guard");

		release();
		const firstResult = await first;
		expect(firstResult.skipped).toBe(false);

		// The handler ran exactly once — the second dispatch did not re-enter
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("different correlationId → both run", async () => {
		const dispatcher = new HookDispatcher({
			config: makeConfig(),
			hooksDir: dir,
			enableReentrancyGuard: true,
		});

		const handler = vi.fn(() => ({}));
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler,
		});

		await Promise.all([
			dispatcher.dispatch({
				event: "task_completed",
				context: makeContext("rg-a", dir),
			}),
			dispatcher.dispatch({
				event: "task_completed",
				context: makeContext("rg-b", dir),
			}),
		]);

		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("sequential dispatches with same correlationId both run (guard releases)", async () => {
		const dispatcher = new HookDispatcher({
			config: makeConfig(),
			hooksDir: dir,
			enableReentrancyGuard: true,
		});

		const handler = vi.fn(() => ({}));
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler,
		});

		const ctx = makeContext("rg-seq", dir);
		const args = { event: "task_completed" as const, context: ctx };

		const r1 = await dispatcher.dispatch(args);
		const r2 = await dispatcher.dispatch(args);

		expect(r1.skipped).toBe(false);
		expect(r2.skipped).toBe(false);
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("guard does not leak: in-flight set cleared after dispatch completes", async () => {
		const dispatcher = new HookDispatcher({
			config: makeConfig(),
			hooksDir: dir,
			enableReentrancyGuard: true,
		});

		const handler = vi.fn(() => ({}));
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler,
		});

		const ctx = makeContext("rg-leak", dir);
		await dispatcher.dispatch({ event: "task_completed", context: ctx });

		// Introspection method exposing currently in-flight guard keys
		expect(dispatcher.getInFlightKeys()).toHaveLength(0);

		// A follow-up dispatch with the same key is not skipped (no stale guard)
		const again = await dispatcher.dispatch({
			event: "task_completed",
			context: ctx,
		});
		expect(again.skipped).toBe(false);
	});

	it("guard disabled by default: concurrent same-key dispatches both run", async () => {
		const dispatcher = new HookDispatcher({
			config: makeConfig(),
			hooksDir: dir,
			// enableReentrancyGuard omitted → false
		});

		const handler = vi.fn(() => ({}));
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler,
		});

		const ctx = makeContext("rg-off", dir);
		const args = { event: "task_completed" as const, context: ctx };

		await Promise.all([dispatcher.dispatch(args), dispatcher.dispatch(args)]);

		// With guard off, both run (legacy behavior)
		expect(handler).toHaveBeenCalledTimes(2);
	});
});

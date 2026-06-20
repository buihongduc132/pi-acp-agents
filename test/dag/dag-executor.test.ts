import { describe, it, expect, vi } from "vitest";
import { DagExecutor } from "../../src/dag/dag-executor.js";
import { DagStore } from "../../src/dag/dag-store.js";
import { TemplateResolver } from "../../src/dag/template-resolver.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { createNoopLogger } from "../../src/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import type { AgentCoordinator } from "../../src/coordination/coordinator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 5.13: Consolidated unit tests for `DagExecutor`.
 *
 * This file is the single end-to-end behavioral contract for the executor.
 * The per-behavior concerns are also pinned individually in the
 * `dag-executor-*.test.ts` companions (constructor / topological-sort /
 * execute / wave-dispatch / gate-evaluation / failfast / completion /
 * circuit-breaker / cancel / resume / stale / retry), but this file draws
 * each concern together into the single test module the task list
 * explicitly asks for, and exercises the behaviors through the public
 * `execute()` / `cancel()` / `resume()` / `resumeAll()` / `markStale()`
 * surface against a real on-disk `DagStore`.
 *
 * Coverage areas (per task 5.13):
 *  1. Linear DAG
 *  2. Parallel waves
 *  3. failFast skip
 *  4. after gate
 *  5. cancel
 *  6. resume
 *  7. stale detection
 *  8. retry (with backoff budget)
 */

/** Stale threshold used throughout the stale-detection suite (1 hour). */
const DEFAULT_STALE_TIMEOUT = 3_600_000;

interface Setup {
	store: DagStore;
	resolver: TemplateResolver;
	circuitBreaker: AcpCircuitBreaker;
	logger: ReturnType<typeof createNoopLogger>;
	dagDir: string;
}

function makeSetup(): Setup {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-exec-consolidated-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

/** Build a DagExecutor wired against a `coordinator.delegate` spy. */
function makeExecutor(
	setup: Setup,
	delegateSpy: ReturnType<typeof vi.fn>,
): { executor: DagExecutor; coordinator: AgentCoordinator } {
	const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
	const executor = new DagExecutor({
		store: setup.store,
		resolver: setup.resolver,
		coordinator,
		circuitBreaker: setup.circuitBreaker,
		logger: setup.logger,
	});
	return { executor, coordinator };
}

/** A delegate that always returns `{text:"ok"}` — used as a default. */
function okDelegate(): ReturnType<typeof vi.fn> {
	return vi.fn(async (_agent: string, _msg: string) => ({
		text: "ok",
		stopReason: "end_turn" as const,
		sessionId: "s",
	}));
}

// ---------------------------------------------------------------------------
// 1. Linear DAG
// ---------------------------------------------------------------------------

describe("DagExecutor (task 5.13) — linear DAG", () => {
	it("executes a linear a → b DAG sequentially and resolves templates between waves", async () => {
		const setup = makeSetup();
		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatched.push(message);
			if (dispatched.length === 1) return { text: "JWT tokens", stopReason: "end_turn" as const, sessionId: "s1" };
			return { text: "impl done", stopReason: "end_turn" as const, sessionId: "s2" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Research auth" },
				{ id: "b", agent: "gemini", prompt: "Implement based on {a.output}", dependsOn: ["a"] },
			],
		});

		await executor.execute(record.dagId);

		// Wave ordering: a dispatched before b.
		expect(dispatched[0]).toBe("Research auth");
		expect(dispatched[1]).toBe("Implement based on JWT tokens");

		const final = setup.store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["a"].output).toBe("JWT tokens");
		expect(final.steps["b"].status).toBe("completed");
		expect(final.steps["b"].output).toBe("impl done");
		expect(final.status).toBe("completed");
	});

	it("transitions a single-step DAG to completed", async () => {
		const setup = makeSetup();
		const { executor } = makeExecutor(setup, okDelegate());

		const record = setup.store.create({
			tasks: [{ id: "solo", agent: "gemini", prompt: "do it" }],
		});

		await executor.execute(record.dagId);

		const final = setup.store.get(record.dagId)!;
		expect(final.status).toBe("completed");
		expect(final.steps["solo"].status).toBe("completed");
	});
});

// ---------------------------------------------------------------------------
// 2. Parallel waves
// ---------------------------------------------------------------------------

describe("DagExecutor (task 5.13) — parallel waves", () => {
	it("executes a 3-wave DAG: [a] → [b,c] → [d], dispatching each wave's steps concurrently", async () => {
		const setup = makeSetup();

		// Track that b and c are BOTH in-flight at the same moment.
		let bStarted = false;
		let cStarted = false;
		let bothRunning = false;

		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			if (message === "B") {
				bStarted = true;
				if (cStarted) bothRunning = true;
				await new Promise((r) => setTimeout(r, 10));
				return { text: "B done", stopReason: "end_turn" as const, sessionId: "sb" };
			}
			if (message === "C") {
				cStarted = true;
				if (bStarted) bothRunning = true;
				await new Promise((r) => setTimeout(r, 10));
				return { text: "C done", stopReason: "end_turn" as const, sessionId: "sc" };
			}
			if (message === "D") {
				return { text: "D done", stopReason: "end_turn" as const, sessionId: "sd" };
			}
			return { text: "A done", stopReason: "end_turn" as const, sessionId: "sa" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "A" },
			{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
			{ id: "c", agent: "gemini", prompt: "C", dependsOn: ["a"] },
			{ id: "d", agent: "gemini", prompt: "D", dependsOn: ["b", "c"] },
		];
		const record = setup.store.create({ tasks });

		await executor.execute(record.dagId);

		expect(bothRunning).toBe(true); // wave 2 ran in parallel

		const final = setup.store.get(record.dagId)!;
		for (const id of ["a", "b", "c", "d"]) {
			expect(final.steps[id].status).toBe("completed");
		}
		expect(final.status).toBe("completed");
	});

	it("does NOT start wave N+1 before wave N settles (sequential waves)", async () => {
		const setup = makeSetup();
		const dispatchOrder: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatchOrder.push(message);
			// small delay so concurrency is observable
			await new Promise((r) => setTimeout(r, 5));
			return { text: `out:${message}`, stopReason: "end_turn" as const, sessionId: "s" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "A" },
				{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "C", dependsOn: ["b"] },
			],
		});

		await executor.execute(record.dagId);

		// Strict wave order: A must be first, C must be last.
		expect(dispatchOrder[0]).toBe("A");
		expect(dispatchOrder[dispatchOrder.length - 1]).toBe("C");
	});
});

// ---------------------------------------------------------------------------
// 3. failFast skip
// ---------------------------------------------------------------------------

describe("DagExecutor (task 5.13) — failFast skip", () => {
	it("failFast=true (default): skips transitive dependents of a failed step, independent branch still runs", async () => {
		const setup = makeSetup();
		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			if (msg === "A") throw new Error("a failed");
			return { text: `out:${msg}`, stopReason: "end_turn" as const, sessionId: "s" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "A" },
				{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "C", dependsOn: ["b"] },
				{ id: "d", agent: "gemini", prompt: "D" },
			],
			// failFast defaults to true
		});

		await executor.execute(record.dagId);

		// Only a (failed) and d (independent) were dispatched.
		expect(delegateSpy).toHaveBeenCalledTimes(2);
		const final = setup.store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("skipped");
		expect(final.steps["c"].status).toBe("skipped");
		expect(final.steps["d"].status).toBe("completed");
		expect(final.status).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// 4. after gate
// ---------------------------------------------------------------------------

describe("DagExecutor (task 5.13) — after gate", () => {
	it("after gate: downstream still executes when the dependency failed, receiving the error as {dep.output}", async () => {
		const setup = makeSetup();
		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			dispatched.push(msg);
			if (msg === "A") throw new Error("a failed");
			return { text: "b done", stopReason: "end_turn" as const, sessionId: "s" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "A" },
				{
					id: "b",
					agent: "gemini",
					prompt: "Review {a.output}",
					dependsOn: ["a"],
					gate: "after",
				},
			],
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(2);
		// Downstream prompt received the failed dep's error message as {a.output}.
		expect(dispatched[1]).toBe("Review a failed");

		const final = setup.store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("completed");
		// A failed step + a completed step ⇒ DAG as a whole did not succeed.
		expect(final.status).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// 5. cancel
// ---------------------------------------------------------------------------

describe("DagExecutor (task 5.13) — cancel", () => {
	it("marks pending steps cancelled, transitions DAG to cancelled, returns a summary", async () => {
		const setup = makeSetup();
		const { executor } = makeExecutor(setup, okDelegate());

		const record = setup.store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "A" },
				{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
			],
		});
		// Move the DAG into running without dispatching so both steps are pending.
		setup.store.updateDagStatus(record.dagId, "running");

		const summary = await executor.cancel(record.dagId);

		expect(summary).toEqual({ completed: 0, aborted: 0, cancelled: 2 });
		const final = setup.store.get(record.dagId)!;
		expect(final.status).toBe("cancelled");
		expect(final.steps["a"].status).toBe("cancelled");
		expect(final.steps["b"].status).toBe("cancelled");
	});

	it("returns a summary reflecting a mixed-state DAG (2 completed / 1 running / 2 pending)", async () => {
		const setup = makeSetup();
		const { executor } = makeExecutor(setup, okDelegate());

		const record = setup.store.create({
			tasks: ["a", "b", "c", "d", "e"].map((id) => ({
				id,
				agent: "gemini",
				prompt: id.toUpperCase(),
			})),
		});
		setup.store.updateDagStatus(record.dagId, "running");
		setup.store.updateStep(record.dagId, "a", (s) => ({ ...s, status: "completed", output: "oa" }));
		setup.store.updateStep(record.dagId, "b", (s) => ({ ...s, status: "completed", output: "ob" }));
		setup.store.updateStep(record.dagId, "c", (s) => ({ ...s, status: "running" }));

		const summary = await executor.cancel(record.dagId);

		expect(summary).toEqual({ completed: 2, aborted: 1, cancelled: 2 });
		const final = setup.store.get(record.dagId)!;
		expect(final.status).toBe("cancelled");
		expect(final.steps["c"].status).toBe("cancelled");
		expect(final.steps["d"].status).toBe("cancelled");
		expect(final.steps["e"].status).toBe("cancelled");
	});

	it("refuses to cancel an already-completed DAG", async () => {
		const setup = makeSetup();
		const { executor } = makeExecutor(setup, okDelegate());

		const record = setup.store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "A" }],
		});
		await executor.execute(record.dagId);
		expect(setup.store.get(record.dagId)!.status).toBe("completed");

		await expect(executor.cancel(record.dagId)).rejects.toThrow(
			/is already completed and cannot be cancelled/,
		);
	});
});

// ---------------------------------------------------------------------------
// 6. resume
// ---------------------------------------------------------------------------

/** 3-wave DAG used by resume scenarios: [a] → [b,c] → [d]. */
const THREE_WAVE_TASKS: DagTaskDefinition[] = [
	{ id: "a", agent: "gemini", prompt: "Step A" },
	{ id: "b", agent: "gemini", prompt: "Step B based on {a.output}", dependsOn: ["a"] },
	{ id: "c", agent: "gemini", prompt: "Step C based on {a.output}", dependsOn: ["a"] },
	{ id: "d", agent: "gemini", prompt: "Step D based on {b.output} and {c.output}", dependsOn: ["b", "c"] },
];

describe("DagExecutor (task 5.13) — resume", () => {
	it("resumes an interrupted DAG: resets running steps to pending, skips completed ones, finishes remaining waves", async () => {
		const setup = makeSetup();
		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatched.push(message);
			return { text: `out-${message}`, stopReason: "end_turn" as const, sessionId: "s" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({ tasks: THREE_WAVE_TASKS });

		// Simulate pi restart mid-wave-2: a + b completed, c was running.
		setup.store.updateDagStatus(record.dagId, "running");
		setup.store.updateStep(record.dagId, "a", (s) => ({ ...s, status: "completed", output: "out-a" }));
		setup.store.updateStep(record.dagId, "b", (s) => ({ ...s, status: "completed", output: "out-b" }));
		setup.store.updateStep(record.dagId, "c", (s) => ({ ...s, status: "running" }));

		await executor.resume(record.dagId);

		// c was re-executed (reset from running); d then executes.
		expect(dispatched.some((m) => m.startsWith("Step C based on"))).toBe(true);
		expect(dispatched.some((m) => m.startsWith("Step D based on"))).toBe(true);
		// a and b were NOT re-dispatched.
		expect(dispatched).not.toContain("Step A");
		expect(dispatched).not.toContain("Step B based on out-a");

		const final = setup.store.get(record.dagId)!;
		expect(final.steps["c"].status).toBe("completed");
		expect(final.steps["d"].status).toBe("completed");
		expect(final.status).toBe("completed");
	});

	it("resumeAll discovers running DAGs and resumes each, skipping terminal/stale ones", async () => {
		const setup = makeSetup();
		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatched.push(message);
			return { text: "ok", stopReason: "end_turn" as const, sessionId: "s" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const running = setup.store.create({
			tasks: [{ id: "x", agent: "gemini", prompt: "X" }],
		});
		setup.store.updateDagStatus(running.dagId, "running");

		const completed = setup.store.create({
			tasks: [{ id: "z", agent: "gemini", prompt: "Z" }],
		});
		setup.store.updateDagStatus(completed.dagId, "completed");

		const resumed = await executor.resumeAll();

		expect(resumed).toContain(running.dagId);
		expect(resumed).not.toContain(completed.dagId);
		expect(dispatched).toContain("X");
		expect(dispatched).not.toContain("Z");
		expect(setup.store.get(running.dagId)!.status).toBe("completed");
	});
});

// ---------------------------------------------------------------------------
// 7. stale detection
// ---------------------------------------------------------------------------

describe("DagExecutor (task 5.13) — stale detection", () => {
	it("marks a running DAG as stale when it has had no transitions within the timeout", () => {
		const setup = makeSetup();
		const { executor } = makeExecutor(setup, okDelegate());

		const record = setup.store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "A" },
				{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
			],
		});
		setup.store.updateDagStatus(record.dagId, "running");

		// Backdate the persisted record so it looks 2h idle.
		backdateRecord(setup, record.dagId, new Date(Date.now() - 2 * DEFAULT_STALE_TIMEOUT).toISOString());

		const staleIds = executor.markStale(DEFAULT_STALE_TIMEOUT);

		expect(staleIds).toContain(record.dagId);
		expect(setup.store.get(record.dagId)!.status).toBe("stale");
	});

	it("does NOT mark a recently-active DAG as stale", () => {
		const setup = makeSetup();
		const { executor } = makeExecutor(setup, okDelegate());

		const record = setup.store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "A" }],
		});
		setup.store.updateDagStatus(record.dagId, "running");

		const staleIds = executor.markStale(DEFAULT_STALE_TIMEOUT);

		expect(staleIds).toEqual([]);
		expect(setup.store.get(record.dagId)!.status).toBe("running");
	});

	it("excludes stale DAGs from auto-resume (resumeAll skips them)", async () => {
		const setup = makeSetup();
		const delegateSpy = okDelegate();
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "A" }],
		});
		setup.store.updateDagStatus(record.dagId, "running");
		backdateRecord(setup, record.dagId, new Date(Date.now() - 2 * DEFAULT_STALE_TIMEOUT).toISOString());

		executor.markStale(DEFAULT_STALE_TIMEOUT);
		expect(setup.store.get(record.dagId)!.status).toBe("stale");

		const resumed = await executor.resumeAll();
		expect(resumed).not.toContain(record.dagId);
		expect(delegateSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 8. retry with backoff budget
// ---------------------------------------------------------------------------

describe("DagExecutor (task 5.13) — retry with backoff budget", () => {
	it("retries a failing step up to maxRetries and tracks retryCount, then succeeds", async () => {
		const setup = makeSetup();
		const delegateSpy = vi.fn(async (_agent: string, _msg: string) => {
			// Fail the first attempt, succeed on the retry.
			if (delegateSpy.mock.calls.length === 1) {
				throw new Error("transient failure");
			}
			return { text: "ok", stopReason: "end_turn" as const, sessionId: "s" };
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
			options: { maxRetries: 1 },
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(2); // initial + 1 retry
		const final = setup.store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["a"].retryCount).toBe(1);
	});

	it("exhausts the retry budget and leaves the step failed", async () => {
		const setup = makeSetup();
		const delegateSpy = vi.fn(async () => {
			throw new Error("permanent failure");
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
			options: { maxRetries: 2 },
		});

		await executor.execute(record.dagId);

		// maxRetries=2 ⇒ initial dispatch + 2 retries = 3 attempts total.
		expect(delegateSpy).toHaveBeenCalledTimes(3);
		const final = setup.store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["a"].error).toBe("permanent failure");
		expect(final.steps["a"].retryCount).toBe(2);
		expect(final.status).toBe("failed");
	});

	it("does not retry when maxRetries is 0 (default)", async () => {
		const setup = makeSetup();
		const delegateSpy = vi.fn(async () => {
			throw new Error("no retries");
		});
		const { executor } = makeExecutor(setup, delegateSpy);

		const record = setup.store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(1);
		const final = setup.store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["a"].retryCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Overwrite the persisted `updatedAt` field on a DAG record to simulate an
 * idle window without any real step transitions (used by the stale suite).
 */
function backdateRecord(setup: Setup, dagId: string, isoDate: string): void {
	const record = setup.store.get(dagId)!;
	record.updatedAt = isoDate;
	writeFileSync(
		join(setup.dagDir, `${dagId}.json`),
		JSON.stringify(record, null, 2) + "\n",
		"utf-8",
	);
}

// Silence the unused-import lint for `readFileSync` — it's intentionally
// re-exported here so future assertions on persisted disk state can lean on
// the same import set without re-declaring it.
void readFileSync;

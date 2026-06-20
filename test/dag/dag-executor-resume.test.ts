import { describe, it, expect, vi } from "vitest";
import { DagExecutor } from "../../src/dag/dag-executor.js";
import { DagStore } from "../../src/dag/dag-store.js";
import { TemplateResolver } from "../../src/dag/template-resolver.js";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { createNoopLogger } from "../../src/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 5.10: Implement resume logic — on startup, find running DAGs,
 * recompute waves from persisted state, skip completed steps, resume from
 * next uncompleted wave.
 *
 * Specs/dag-resume "Resume from last checkpoint after pi restart":
 *  - When pi restarts and finds a running DAG, resume execution from the
 *    next uncompleted wave. Steps already completed SHALL NOT be re-executed.
 *  - Scenario "Resume a DAG interrupted by pi restart": waves
 *    [["a"], ["b", "c"], ["d"]], wave 1 completed, wave 2 in progress
 *    (b completed, c running) → mark c as pending (needs retry), resume
 *    from wave 2 — re-execute c, then proceed to wave 3.
 *  - Scenario "Skip already-completed steps on resume": a, b completed, c
 *    pending → do NOT re-execute a or b; use their stored outputs for
 *    template resolution and only execute c.
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-resume-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

function makeCoordinator(
	delegateSpy: ReturnType<typeof vi.fn>,
): AgentCoordinator {
	return { delegate: delegateSpy } as unknown as AgentCoordinator;
}

/** 3-wave DAG: [["a"], ["b", "c"], ["d"]] — b,c depend on a; d on b+c. */
const THREE_WAVE_TASKS: DagTaskDefinition[] = [
	{ id: "a", agent: "gemini", prompt: "Step A" },
	{ id: "b", agent: "gemini", prompt: "Step B based on {a.output}", dependsOn: ["a"] },
	{ id: "c", agent: "gemini", prompt: "Step C based on {a.output}", dependsOn: ["a"] },
	{ id: "d", agent: "gemini", prompt: "Step D based on {b.output} and {c.output}", dependsOn: ["b", "c"] },
];

describe("DagExecutor.resume (task 5.10)", () => {
	it("resumes a DAG interrupted mid-wave: resets running steps to pending and re-executes them", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatched.push(message);
			return { text: `out-${message}`, stopReason: "end_turn" as const, sessionId: "s" };
		});
		const coordinator = makeCoordinator(delegateSpy);
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({ tasks: THREE_WAVE_TASKS });

		// Simulate a pi restart mid-wave-2: wave 1 (a) completed, wave 2 had
		// b completed but c was still running when the process died.
		store.updateDagStatus(record.dagId, "running");
		store.updateStep(record.dagId, "a", (s) => ({ ...s, status: "completed", output: "out-a" }));
		store.updateStep(record.dagId, "b", (s) => ({ ...s, status: "completed", output: "out-b" }));
		store.updateStep(record.dagId, "c", (s) => ({ ...s, status: "running" }));
		// d remains pending.

		await executor.resume(record.dagId);

		// c was reset to pending and re-executed; d then executes.
		// a and b MUST NOT be re-dispatched.
		expect(dispatched.some((m) => m.startsWith("Step C based on"))).toBe(true);
		expect(dispatched.some((m) => m.startsWith("Step D based on"))).toBe(true);
		// a and b were NOT re-executed.
		expect(dispatched).not.toContain("Step A");
		expect(dispatched).not.toContain("Step B based on out-a");

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["b"].status).toBe("completed");
		expect(final.steps["c"].status).toBe("completed");
		expect(final.steps["d"].status).toBe("completed");
		expect(final.status).toBe("completed");
	});

	it("skips already-completed steps on resume and only executes pending ones", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatched.push(message);
			return { text: `out-${message}`, stopReason: "end_turn" as const, sessionId: "s" };
		});
		const coordinator = makeCoordinator(delegateSpy);
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({ tasks: THREE_WAVE_TASKS });

		// Simulate: a and b completed, c and d still pending (wave 2 partially
		// done — c never started). No step left "running".
		store.updateDagStatus(record.dagId, "running");
		store.updateStep(record.dagId, "a", (s) => ({ ...s, status: "completed", output: "out-a" }));
		store.updateStep(record.dagId, "b", (s) => ({ ...s, status: "completed", output: "out-b" }));

		await executor.resume(record.dagId);

		// Only c and d should be dispatched.
		expect(dispatched).toContain("Step C based on out-a");
		expect(dispatched.some((m) => m.startsWith("Step D based on"))).toBe(true);
		expect(dispatched).not.toContain("Step A");
		expect(dispatched).not.toContain("Step B based on out-a");

		const final = store.get(record.dagId)!;
		expect(final.steps["c"].status).toBe("completed");
		expect(final.steps["d"].status).toBe("completed");
		expect(final.status).toBe("completed");
	});

	it("uses persisted outputs of completed steps for template resolution on resume", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		let dPrompt = "";
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			if (message.startsWith("Step D")) dPrompt = message;
			return { text: "fresh-out", stopReason: "end_turn" as const, sessionId: "s" };
		});
		const coordinator = makeCoordinator(delegateSpy);
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({ tasks: THREE_WAVE_TASKS });

		// a, b, c already completed with persisted outputs; only d pending.
		store.updateDagStatus(record.dagId, "running");
		store.updateStep(record.dagId, "a", (s) => ({ ...s, status: "completed", output: "persisted-a" }));
		store.updateStep(record.dagId, "b", (s) => ({ ...s, status: "completed", output: "persisted-b" }));
		store.updateStep(record.dagId, "c", (s) => ({ ...s, status: "completed", output: "persisted-c" }));

		await executor.resume(record.dagId);

		// d's prompt MUST resolve against the PERSISTED outputs, not re-run deps.
		expect(dPrompt).toBe("Step D based on persisted-b and persisted-c");
		expect(delegateSpy).toHaveBeenCalledTimes(1); // only d dispatched

		const final = store.get(record.dagId)!;
		expect(final.status).toBe("completed");
		expect(final.steps["d"].output).toBe("fresh-out");
	});

	it("throws when resuming a non-existent DAG", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn();
		const coordinator = makeCoordinator(delegateSpy);
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		await expect(executor.resume("missing")).rejects.toThrow(/not found/);
	});
});

describe("DagExecutor.resumeAll (task 5.10)", () => {
	it("finds all running DAGs via the store and resumes each, skipping terminal ones", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatched.push(message);
			return { text: "ok", stopReason: "end_turn" as const, sessionId: "s" };
		});
		const coordinator = makeCoordinator(delegateSpy);
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// DAG 1: interrupted mid-wave — a completed, b running.
		const rec1 = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "A1" },
				{ id: "b", agent: "gemini", prompt: "B1", dependsOn: ["a"] },
			] as DagTaskDefinition[],
		});
		store.updateDagStatus(rec1.dagId, "running");
		store.updateStep(rec1.dagId, "a", (s) => ({ ...s, status: "completed", output: "oa1" }));
		store.updateStep(rec1.dagId, "b", (s) => ({ ...s, status: "running" }));

		// DAG 2: fully pending, status running.
		const rec2 = store.create({
			tasks: [{ id: "x", agent: "gemini", prompt: "X2" }] as DagTaskDefinition[],
		});
		store.updateDagStatus(rec2.dagId, "running");

		// DAG 3: already completed — must NOT be resumed.
		const rec3 = store.create({
			tasks: [{ id: "z", agent: "gemini", prompt: "Z3" }] as DagTaskDefinition[],
		});
		store.updateDagStatus(rec3.dagId, "completed");
		store.updateStep(rec3.dagId, "z", (s) => ({ ...s, status: "completed", output: "oz3" }));

		const resumed = await executor.resumeAll();

		// Both running DAGs resumed; the completed one excluded.
		expect(resumed).toHaveLength(2);
		expect(resumed).toContain(rec1.dagId);
		expect(resumed).toContain(rec2.dagId);
		expect(resumed).not.toContain(rec3.dagId);

		// b was re-executed (reset from running), x executed; z NOT re-executed.
		expect(dispatched).toContain("B1");
		expect(dispatched).toContain("X2");
		expect(dispatched).not.toContain("Z3");

		expect(store.get(rec1.dagId)!.status).toBe("completed");
		expect(store.get(rec2.dagId)!.status).toBe("completed");
		expect(store.get(rec3.dagId)!.status).toBe("completed");
	});

	it("returns an empty list when no DAGs need resuming", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn();
		const coordinator = makeCoordinator(delegateSpy);
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const resumed = await executor.resumeAll();
		expect(resumed).toEqual([]);
		expect(delegateSpy).not.toHaveBeenCalled();
	});

	it("continues resuming remaining DAGs even if one throws", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		// Two running DAGs. The first will fail its dispatch; the second should
		// still be resumed (one bad DAG must not abort the whole resume pass).
		const rec1 = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "A1" }] as DagTaskDefinition[],
		});
		store.updateDagStatus(rec1.dagId, "running");

		const rec2 = store.create({
			tasks: [{ id: "x", agent: "gemini", prompt: "X2" }] as DagTaskDefinition[],
		});
		store.updateDagStatus(rec2.dagId, "running");

		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			if (message === "A1") throw new Error("agent crashed");
			return { text: "ok", stopReason: "end_turn" as const, sessionId: "s" };
		});
		const coordinator = makeCoordinator(delegateSpy);
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const resumed = await executor.resumeAll();
		// Both DAGs were attempted.
		expect(resumed).toHaveLength(2);
		expect(store.get(rec1.dagId)!.status).toBe("failed");
		expect(store.get(rec2.dagId)!.status).toBe("completed");
	});
});

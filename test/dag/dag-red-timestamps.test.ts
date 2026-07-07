import { describe, it, expect, vi } from "vitest";
import { DagExecutor } from "../../src/dag/dag-executor.js";
import { DagStore } from "../../src/dag/dag-store.js";
import { TemplateResolver } from "../../src/dag/template-resolver.js";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { createNoopLogger } from "../../src/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { DagTaskDefinition, DagStepRecord } from "../../src/config/types.js";

/**
 * RED PHASE (TDD) — Finding P3: Timestamp/duration mismatch.
 *
 * `dispatchStep()` captures a LOCAL `startedAt` (~L564), persists it via the
 * "running" updateStep, then on each terminal branch computes:
 *
 *   const completedAt = new Date().toISOString();
 *   const durationMs = Date.parse(completedAt) - Date.parse(startedAt);  // LOCAL
 *   this.store.updateStep(dagId, step.id, (s) => ({
 *     ...s,                                   // <-- DISK startedAt wins
 *     status: "completed",
 *     completedAt,
 *     durationMs,                             // <-- LOCAL startedAt used
 *   }));
 *
 * The persisted `startedAt` comes from the DISK (via `...s`) while `durationMs`
 * is computed from the LOCAL closure variable. These are DECOUPLED: any write
 * that re-stamps `startedAt` on disk between the running write and the terminal
 * write makes them disagree — exactly the smoke-test symptom (persisted gap
 * ~639ms vs durationMs ~17906ms).
 *
 * These tests assert the CORRECT invariant:
 *   durationMs ≈ Date.parse(completedAt) - Date.parse(startedAt)
 * A failure = the bug.
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-red-ts-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

function makeDagDefinition(
	tasks: Array<{ id: string; agent: string; prompt: string; dependsOn?: string[] }>,
): { tasks: DagTaskDefinition[] } {
	return { tasks };
}

function makeDelayedCoordinator(
	delayMs: number,
	text = "done",
): { instance: AgentCoordinator; delegateSpy: ReturnType<typeof vi.fn> } {
	const delegateSpy = vi.fn(
		async (_agentName: string, _message: string) => {
			await new Promise((r) => setTimeout(r, delayMs));
			return { text, stopReason: "end_turn" as const, sessionId: "sess-1" };
		},
	);
	const instance = { delegate: delegateSpy } as unknown as AgentCoordinator;
	return { instance, delegateSpy };
}

function makeAbortingCoordinator(
	delayMs: number,
): { instance: AgentCoordinator; delegateSpy: ReturnType<typeof vi.fn> } {
	const delegateSpy = vi.fn(
		async (_agentName: string, _message: string) => {
			await new Promise((r) => setTimeout(r, delayMs));
			throw new DOMException("cancelled", "AbortError");
		},
	);
	const instance = { delegate: delegateSpy } as unknown as AgentCoordinator;
	return { instance, delegateSpy };
}

function makeFailingCoordinator(
	delayMs: number,
	message = "agent blew up",
): { instance: AgentCoordinator; delegateSpy: ReturnType<typeof vi.fn> } {
	const delegateSpy = vi.fn(
		async (_agentName: string, _message: string) => {
			await new Promise((r) => setTimeout(r, delayMs));
			throw new Error(message);
		},
	);
	const instance = { delegate: delegateSpy } as unknown as AgentCoordinator;
	return { instance, delegateSpy };
}

/**
 * Shared assertion: the persisted timestamps must be internally consistent.
 *   1. All three fields present (startedAt, completedAt, durationMs).
 *   2. startedAt <= completedAt.
 *   3. |durationMs - (completedAt - startedAt)| < tolerance.
 */
function expectTimestampConsistency(step: DagStepRecord, toleranceMs = 1000): void {
	expect(step.startedAt, "startedAt must be persisted").toBeDefined();
	expect(step.completedAt, "completedAt must be persisted").toBeDefined();
	expect(step.durationMs, "durationMs must be persisted").not.toBeUndefined();

	const started = Date.parse(step.startedAt as string);
	const completed = Date.parse(step.completedAt as string);
	expect(Number.isNaN(started), `startedAt unparseable: ${step.startedAt}`).toBe(false);
	expect(Number.isNaN(completed), `completedAt unparseable: ${step.completedAt}`).toBe(false);

	expect(started, "startedAt must be <= completedAt").toBeLessThanOrEqual(completed);

	const expectedDuration = completed - started;
	const actualDuration = step.durationMs as number;
	const drift = Math.abs(actualDuration - expectedDuration);
	expect(
		drift,
		`durationMs (${actualDuration}) must match completedAt-startedAt (${expectedDuration}); drift ${drift}ms > ${toleranceMs}ms tolerance`,
	).toBeLessThan(toleranceMs);
}

describe("RED — P3 timestamp/duration consistency", () => {
	it("COMPLETED branch: durationMs agrees with persisted timestamps", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeDelayedCoordinator(50);

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "do work" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expectTimestampConsistency(final.steps["a"]);
	});

	it("CANCELLED branch: durationMs agrees with persisted timestamps", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeAbortingCoordinator(50);

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "do work" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("cancelled");
		expectTimestampConsistency(final.steps["a"]);
	});

	it("FAILED branch: durationMs agrees with persisted timestamps", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeFailingCoordinator(50);

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "do work" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expectTimestampConsistency(final.steps["a"]);
	});

	it("CONCURRENCY: 2 parallel steps in a wave — no lost-update on startedAt", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator, delegateSpy } = makeDelayedCoordinator(50);

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// Wave 1: a and b have NO dependencies between them — dispatched in parallel.
		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B" },
		]));

		const t0 = Date.now();
		await executor.execute(record.dagId);
		const t1 = Date.now();

		expect(delegateSpy).toHaveBeenCalledTimes(2);

		const final = store.get(record.dagId)!;
		const stepA = final.steps["a"];
		const stepB = final.steps["b"];

		expect(stepA.status).toBe("completed");
		expect(stepB.status).toBe("completed");

		// Each step individually consistent.
		expectTimestampConsistency(stepA);
		expectTimestampConsistency(stepB);

		// Cross-step sanity: both startedAt must be within the exec window.
		const startA = Date.parse(stepA.startedAt as string);
		const startB = Date.parse(stepB.startedAt as string);
		expect(Number.isNaN(startA)).toBe(false);
		expect(Number.isNaN(startB)).toBe(false);
		expect(startA, "step A startedAt within exec window").toBeGreaterThanOrEqual(t0);
		expect(startA, "step A startedAt within exec window").toBeLessThanOrEqual(t1);
		expect(startB, "step B startedAt within exec window").toBeGreaterThanOrEqual(t0);
		expect(startB, "step B startedAt within exec window").toBeLessThanOrEqual(t1);
	});

	it("CONCURRENCY (many steps): a larger parallel wave survives clobbering", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delays: Record<string, number> = { A: 20, B: 40, C: 60, D: 30, E: 50 };
		const delegateSpy = vi.fn(
			async (_agentName: string, message: string) => {
				const letter = message.replace("Step ", "");
				await new Promise((r) => setTimeout(r, delays[letter] ?? 30));
				return { text: message, stopReason: "end_turn" as const, sessionId: "s1" };
			},
		);
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B" },
			{ id: "c", agent: "gemini", prompt: "Step C" },
			{ id: "d", agent: "gemini", prompt: "Step D" },
			{ id: "e", agent: "gemini", prompt: "Step E" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		for (const id of ["a", "b", "c", "d", "e"]) {
			expect(final.steps[id].status, `step ${id} completed`).toBe("completed");
			expectTimestampConsistency(final.steps[id]);
		}
	});

	/**
	 * THE REAL TRIGGER. Tests 1–5 pass because the executor's own writes are
	 * serialized on the single Node event loop (synchronous file I/O). But the
	 * terminal branches persist the DISK `startedAt` (`...s`) while computing
	 * `durationMs` from the LOCAL `startedAt`. Any concurrent writer that
	 * re-stamps `startedAt` between the running write and the terminal write
	 * desynchronises them.
	 *
	 * This models the realistic production hazard: the real `delegate` carries
	 * an `onProgress` callback, the store does index reconciliation on every
	 * write, a heartbeat/status poller, or a second process touching the same
	 * record file. The smoke test that surfaced P3 ran real (multi-second)
	 * agent sessions where such mid-flight writes are plausible.
	 *
	 * We simulate the concurrent re-stamp and assert the SAME invariant the
	 * other tests assert: durationMs must agree with the persisted timestamps.
	 * This FAILS today — proving the decoupling bug.
	 */
	it("FIELD-DECOUPLING: terminal branch trusts disk startedAt, not the local one used for durationMs", async () => {
		const { store, resolver, circuitBreaker, logger, dagDir } = makeSetup();

		// Create the record first so the delegate closure can capture its id.
		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "do work" },
		]));
		const recordId = record.dagId;

		// Capture the running write's startedAt so the concurrent writer can
		// re-stamp it to a deterministic LATER value.
		let runningStartedAt = "";
		const realUpdateStep = store.updateStep.bind(store);
		store.updateStep = (dagId, stepId, mutate) => {
			const result = realUpdateStep(dagId, stepId, mutate);
			const after = store.get(dagId)?.steps[stepId];
			if (after?.status === "running" && after.startedAt) {
				runningStartedAt = after.startedAt;
			}
			return result;
		};

		// The delegate resolves, then a concurrent writer re-stamps the in-flight
		// step's startedAt. Scaled-down analogue of the ~18s smoke window:
		// delegate runs 2000ms, re-stamp pushes startedAt +1500ms, so completedAt
		// (T0+2000) still lands AFTER the re-stamped startedAt (T0+1500) —
		// reproducing the exact symptom shape: durationMs(2000) ≫ persisted
		// gap(500), both positive.
		const delegateSpy = vi.fn(
			async (_agentName: string, _message: string) => {
				await new Promise((r) => setTimeout(r, 2000));
				// --- concurrent writer (heartbeat / progress poller) ---
				const rec = store.get(recordId)!;
				const later = new Date(Date.parse(runningStartedAt) + 1500).toISOString();
				rec.steps["a"].startedAt = later;
				writeFileSync(join(dagDir, `${recordId}.json`), JSON.stringify(rec, null, 2) + "\n", "utf-8");
				return { text: "done", stopReason: "end_turn" as const, sessionId: "s1" };
			},
		);
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		await executor.execute(recordId);

		const final = store.get(recordId)!;
		expect(final.steps["a"].status).toBe("completed");
		// durationMs was computed from the ORIGINAL startedAt (2000ms of work),
		// but the persisted startedAt was re-stamped +1500ms by the concurrent
		// writer and dispatchStep's terminal branch trusted the disk value.
		// => persisted gap = 500ms, durationMs = 2000ms, drift = 1500ms > 1000ms.
		// This FAILS today — reproducing the exact smoke-test symptom shape.
		expectTimestampConsistency(final.steps["a"]);
	});
});

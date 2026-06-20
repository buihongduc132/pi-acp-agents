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
 * Task 5.9: Implement `cancel(dagId)` — abort in-flight agent sessions,
 * mark pending steps as `cancelled`, transition DAG to `cancelled`.
 *
 * Specs/dag-monitoring "DAG cancellation":
 *  - Cancel a running DAG: with 2 completed, 1 running, 2 pending → abort
 *    the running step's agent session, mark the 2 pending steps as
 *    cancelled, transition the DAG to cancelled, return summary
 *    `{completed: 2, aborted: 1, cancelled: 2}`.
 *  - Cancel an already-completed DAG → error:
 *    `DAG "<dagId>" is already completed and cannot be cancelled`.
 *  - Cancel is best-effort for in-flight steps: a step MAY complete
 *    successfully if the agent finished before the cancel signal was
 *    processed; the system reflects the actual outcome in the step status.
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-cancel-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

function withCoordinator(
	store: DagStore,
	resolver: TemplateResolver,
	circuitBreaker: AcpCircuitBreaker,
	logger: ReturnType<typeof createNoopLogger>,
	delegateSpy: ReturnType<typeof vi.fn>,
) {
	const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
	const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });
	return { executor, coordinator };
}

describe("DagExecutor.cancel (task 5.9) — error cases", () => {
	it("throws when the DAG does not exist", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn();
		const { executor } = withCoordinator(store, resolver, circuitBreaker, logger, delegateSpy);

		await expect(executor.cancel("nope")).rejects.toThrow(/not found/);
	});

	it("throws when the DAG is already completed", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn(async () => ({
			text: "ok",
			stopReason: "end_turn" as const,
			sessionId: "s1",
		}));
		const { executor } = withCoordinator(store, resolver, circuitBreaker, logger, delegateSpy);

		const tasks: DagTaskDefinition[] = [{ id: "a", agent: "gemini", prompt: "A" }];
		const record = store.create({ tasks });
		await executor.execute(record.dagId);
		expect(store.get(record.dagId)!.status).toBe("completed");

		await expect(executor.cancel(record.dagId)).rejects.toThrow(
			/is already completed and cannot be cancelled/,
		);
	});

	it("throws when the DAG is already failed", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn(async () => {
			throw new Error("boom");
		});
		const { executor } = withCoordinator(store, resolver, circuitBreaker, logger, delegateSpy);

		const tasks: DagTaskDefinition[] = [{ id: "a", agent: "gemini", prompt: "A" }];
		const record = store.create({ tasks });
		await executor.execute(record.dagId);
		expect(store.get(record.dagId)!.status).toBe("failed");

		await expect(executor.cancel(record.dagId)).rejects.toThrow(/is already failed/);
	});

	it("throws when the DAG is already cancelled", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn();
		const { executor } = withCoordinator(store, resolver, circuitBreaker, logger, delegateSpy);

		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "A" },
			{ id: "b", agent: "gemini", prompt: "B" },
		];
		const record = store.create({ tasks });
		// Simulate a prior cancellation by transitioning directly.
		store.updateDagStatus(record.dagId, "cancelled");

		await expect(executor.cancel(record.dagId)).rejects.toThrow(/is already cancelled/);
	});
});

describe("DagExecutor.cancel (task 5.9) — pending steps + DAG transition", () => {
	it("marks pending steps as cancelled, transitions DAG to cancelled, returns summary", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn();
		const { executor } = withCoordinator(store, resolver, circuitBreaker, logger, delegateSpy);

		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "A" },
			{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
		];
		const record = store.create({ tasks });
		// Move the DAG into running without dispatching, so both steps are pending.
		store.updateDagStatus(record.dagId, "running");

		const summary = await executor.cancel(record.dagId);

		expect(summary).toEqual({ completed: 0, aborted: 0, cancelled: 2 });
		expect(delegateSpy).not.toHaveBeenCalled();

		const final = store.get(record.dagId)!;
		expect(final.status).toBe("cancelled");
		expect(final.steps["a"].status).toBe("cancelled");
		expect(final.steps["b"].status).toBe("cancelled");
		expect(final.completedAt).toBeTruthy();
	});

	it("returns a summary reflecting a mixed-state DAG (completed/running/pending)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const delegateSpy = vi.fn();
		const { executor } = withCoordinator(store, resolver, circuitBreaker, logger, delegateSpy);

		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "A" },
			{ id: "b", agent: "gemini", prompt: "B" },
			{ id: "c", agent: "gemini", prompt: "C" },
			{ id: "d", agent: "gemini", prompt: "D" },
			{ id: "e", agent: "gemini", prompt: "E" },
		];
		const record = store.create({ tasks });
		store.updateDagStatus(record.dagId, "running");
		// 2 completed, 1 running, 2 pending — mirrors the spec scenario.
		store.updateStep(record.dagId, "a", (s) => ({ ...s, status: "completed", output: "oa" }));
		store.updateStep(record.dagId, "b", (s) => ({ ...s, status: "completed", output: "ob" }));
		store.updateStep(record.dagId, "c", (s) => ({ ...s, status: "running" }));

		const summary = await executor.cancel(record.dagId);

		expect(summary).toEqual({ completed: 2, aborted: 1, cancelled: 2 });

		const final = store.get(record.dagId)!;
		expect(final.status).toBe("cancelled");
		// completed steps are left untouched.
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["b"].status).toBe("completed");
		// running + pending are marked cancelled.
		expect(final.steps["c"].status).toBe("cancelled");
		expect(final.steps["d"].status).toBe("cancelled");
		expect(final.steps["e"].status).toBe("cancelled");
	});
});

describe("DagExecutor.cancel (task 5.9) — in-flight abort", () => {
	it("aborts in-flight agent sessions and counts them as aborted", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		let capturedSignal: AbortSignal | undefined;
		// A delegate that blocks until its abort signal fires, mirroring a
		// long-running in-flight agent session.
		const delegateSpy = vi.fn(
			async (
				_agent: string,
				_msg: string,
				_cwd?: string,
				_onProgress?: unknown,
				signal?: AbortSignal,
			) => {
				capturedSignal = signal;
				return new Promise((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							reject(new DOMException("Operation cancelled", "AbortError"));
						},
						{ once: true },
					);
				});
			},
		);
		const { executor } = withCoordinator(store, resolver, circuitBreaker, logger, delegateSpy);

		const tasks: DagTaskDefinition[] = [{ id: "a", agent: "gemini", prompt: "A" }];
		const record = store.create({ tasks });

		// Kick off execution in the background — step "a" will block in-flight.
		const execPromise = executor.execute(record.dagId);
		await vi.waitFor(() => expect(delegateSpy).toHaveBeenCalled());

		// The dispatch MUST have been given an abort signal.
		expect(capturedSignal).toBeTruthy();
		expect(capturedSignal!.aborted).toBe(false);

		const summary = await executor.cancel(record.dagId);
		expect(summary.aborted).toBe(1);
		expect(capturedSignal!.aborted).toBe(true);

		// Let the execute loop settle after the abort rejects the dispatch.
		await execPromise;

		const final = store.get(record.dagId)!;
		expect(final.status).toBe("cancelled");
		expect(final.steps["a"].status).toBe("cancelled");
	});
});

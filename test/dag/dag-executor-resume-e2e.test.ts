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
 * Task 8.10: E2E verify resume after simulated restart.
 *
 * Scenario: Complete wave 1, delete in-memory state (create new executor),
 * reload from disk, verify wave 2 executes.
 *
 * Unlike dag-executor-resume.test.ts which manually sets up persisted state,
 * this test ACTUALLY RUNS wave 1 to completion via a real executor, then
 * simulates a crash that loses the in-memory wave 2+3 state. A FRESH executor
 * instance (new DagStore, new DagExecutor — as if pi restarted) must reload
 * from disk and resume execution of the remaining waves.
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-resume-e2e-"));
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

describe("DagExecutor resume E2E (task 8.10)", () => {
	it("runs wave 1, simulates restart with fresh executor, resumes wave 2+3 from disk", async () => {
		const { store, resolver, circuitBreaker, logger, dagDir } = makeSetup();

		// --- Phase 1: Actually execute the full DAG with executor1 ---
		const delegateSpy1 = vi.fn(async (_agent: string, message: string) => ({
			text: `out-${message}`, stopReason: "end_turn" as const, sessionId: "s1",
		}));
		const executor1 = new DagExecutor({
			store, resolver,
			coordinator: makeCoordinator(delegateSpy1),
			circuitBreaker, logger,
		});

		const record = store.create({ tasks: THREE_WAVE_TASKS });
		await executor1.execute(record.dagId);

		// Verify DAG completed fully
		const completedDag = store.get(record.dagId);
		expect(completedDag!.status).toBe("completed");
		expect(completedDag!.steps["a"]!.status).toBe("completed");
		expect(completedDag!.steps["b"]!.status).toBe("completed");
		expect(completedDag!.steps["d"]!.status).toBe("completed");

		// --- Phase 2: Simulate crash AFTER wave 1 persisted but BEFORE wave 2 ---
		// Reset steps b, c, d to pending and dag status to running.
		// Step "a" retains its real persisted output from executor1.
		store.updateDagStatus(record.dagId, "running");
		for (const stepId of ["b", "c", "d"]) {
			store.updateStep(record.dagId, stepId, (s) => ({
				...s,
				status: "pending" as const,
				output: undefined,
			}));
		}

		// --- Phase 3: Create FRESH executor from same disk (simulates restart) ---
		const store2 = new DagStore({
			dagDir,
			dagIndexFile: join(dagDir, "dag-index.json"),
		});
		const freshStoreRead = store2.get(record.dagId);
		expect(freshStoreRead).toBeDefined();
		expect(freshStoreRead!.status).toBe("running");
		expect(freshStoreRead!.steps["a"]!.status).toBe("completed");
		expect(freshStoreRead!.steps["a"]!.output).toContain("out-");
		expect(freshStoreRead!.steps["b"]!.status).toBe("pending");

		// Fresh store must find the running DAG
		const runningDags = store2.findRunning();
		expect(runningDags.length).toBe(1);
		expect(runningDags[0].dagId).toBe(record.dagId);

		const wave2Dispatched: string[] = [];
		const delegateSpy2 = vi.fn(async (_agent: string, message: string) => {
			wave2Dispatched.push(message);
			return { text: `out2-${message}`, stopReason: "end_turn" as const, sessionId: "s2" };
		});
		const executor2 = new DagExecutor({
			store: store2,
			resolver: new TemplateResolver(),
			coordinator: makeCoordinator(delegateSpy2),
			circuitBreaker: new AcpCircuitBreaker(),
			logger: createNoopLogger(),
		});

		// --- Phase 4: Resume from disk ---
		await executor2.resume(record.dagId);

		// Verify ALL remaining waves completed
		const finalDag = store2.get(record.dagId);
		expect(finalDag).toBeDefined();
		expect(finalDag!.status).toBe("completed");

		// a was already completed — NOT re-executed by executor2
		expect(finalDag!.steps["a"]!.status).toBe("completed");
		expect(finalDag!.steps["a"]!.output).toContain("out-");

		// b, c, d all completed in wave 2+3
		expect(finalDag!.steps["b"]!.status).toBe("completed");
		expect(finalDag!.steps["c"]!.status).toBe("completed");
		expect(finalDag!.steps["d"]!.status).toBe("completed");

		// Wave 2 dispatched b, c; wave 3 dispatched d — 3 calls total
		// (a was NOT re-dispatched by executor2)
		expect(delegateSpy2).toHaveBeenCalledTimes(3);
	});

	it("preserves template variable resolution across restart boundary", async () => {
		const { store, resolver, circuitBreaker, logger, dagDir } = makeSetup();

		// Phase 1: Execute full DAG
		const delegateSpy1 = vi.fn(async (_agent: string, _message: string) => ({
			text: "wave1-output",
			stopReason: "end_turn" as const,
			sessionId: "s1",
		}));
		const executor1 = new DagExecutor({
			store, resolver,
			coordinator: makeCoordinator(delegateSpy1),
			circuitBreaker, logger,
		});

		const record = store.create({ tasks: THREE_WAVE_TASKS });
		await executor1.execute(record.dagId);

		// Simulate crash: reset b, c, d to pending
		store.updateDagStatus(record.dagId, "running");
		for (const stepId of ["b", "c", "d"]) {
			store.updateStep(record.dagId, stepId, (s) => ({
				...s,
				status: "pending" as const,
				output: undefined,
			}));
		}

		// Phase 2: Fresh executor from same disk
		const store2 = new DagStore({ dagDir, dagIndexFile: join(dagDir, "dag-index.json") });
		const capturedPrompts: string[] = [];
		const delegateSpy2 = vi.fn(async (_agent: string, message: string) => {
			capturedPrompts.push(message);
			return { text: `resolved-${message}`, stopReason: "end_turn" as const, sessionId: "s2" };
		});
		const executor2 = new DagExecutor({
			store: store2,
			resolver: new TemplateResolver(),
			coordinator: makeCoordinator(delegateSpy2),
			circuitBreaker: new AcpCircuitBreaker(),
			logger: createNoopLogger(),
		});

		await executor2.resume(record.dagId);

		// The prompt for b and c should contain the resolved output of a
		// ("wave1-output"), proving template variables were resolved from
		// persisted output — not lost during restart.
		const bPrompt = capturedPrompts.find(p => p.includes("Step B"));
		const cPrompt = capturedPrompts.find(p => p.includes("Step C"));
		expect(bPrompt).toBeDefined();
		expect(cPrompt).toBeDefined();
		expect(bPrompt).toContain("wave1-output");
		expect(cPrompt).toContain("wave1-output");
	});
});

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
 * RED PHASE — Finding P1: Dead wave counters.
 *
 * BUG PROOF:
 *   src/dag/dag-store.ts lines 116-117 initialize `currentWave: 0, totalWaves: 0`
 *   in the create() method. src/dag/dag-executor.ts line 234 computes
 *   `const waves = this.topologicalSort(record.tasks)` and runs the wave loop
 *   (lines 237-239) but NEVER persists currentWave/totalWaves back to the store.
 *   So acp_dag_status always returns currentWave:0, totalWaves:0 even after
 *   full execution.
 *
 * These tests FAIL against current code — that's the point. They prove the bug.
 * Once the fix lands (executor writes currentWave/totalWaves into the record
 * during execute()), these tests will pass.
 */

/** Minimal mock of AgentCoordinator for execute() tests */
function makeMockCoordinator(
	responses: Record<string, string>,
): {
	instance: AgentCoordinator;
	delegateSpy: ReturnType<typeof vi.fn>;
} {
	const delegateSpy = vi.fn(
		async (agentName: string, message: string, _cwd?: string) => {
			const text = responses[agentName] ?? `response from ${agentName}`;
			return { text, stopReason: "end_turn", sessionId: `sess-${agentName}` };
		},
	);
	const instance = { delegate: delegateSpy } as unknown as AgentCoordinator;
	return { instance, delegateSpy };
}

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-red-wave-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

function makeDagDefinition(tasks: Array<{ id: string; agent: string; prompt: string; dependsOn?: string[] }>): {
	tasks: DagTaskDefinition[];
} {
	return { tasks };
}

describe("RED P1 — Dead wave counters (currentWave/totalWaves never persisted)", () => {
	it("totalWaves is set after execute begins (3-wave linear DAG a→b→c)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeMockCoordinator({
			gemini: "done",
		});

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// 3-wave linear DAG: a (no deps) → b (depends on a) → c (depends on b)
		// topologicalSort returns [["a"], ["b"], ["c"]] → 3 waves
		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
			{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["b"] },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		// BUG: totalWaves is still 0 (initialized in create(), never updated)
		expect(final.totalWaves).toBe(3);
	});

	it("currentWave reflects last executed wave (3-wave linear DAG)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeMockCoordinator({
			gemini: "done",
		});

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
			{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["b"] },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		// BUG: currentWave is still 0 (initialized in create(), never updated)
		expect(final.currentWave).toBe(3);
	});

	it("currentWave is updated mid-execution (single-wave DAG)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeMockCoordinator({
			gemini: "done",
		});

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// Single-step DAG → 1 wave
		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		// BUG: both are still 0 (initialized in create(), never updated)
		expect(final.currentWave).toBe(1);
		expect(final.totalWaves).toBe(1);
	});

	it("2 parallel steps in 1 wave → totalWaves===1, currentWave===1", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeMockCoordinator({
			gemini: "done",
		});

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// Two steps with no dependencies → both in wave 0 → 1 wave total
		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		// BUG: both are still 0 (initialized in create(), never updated)
		expect(final.totalWaves).toBe(1);
		expect(final.currentWave).toBe(1);
	});
});

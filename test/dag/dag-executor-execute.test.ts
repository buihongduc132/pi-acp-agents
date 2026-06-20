import { describe, it, expect, vi, beforeEach } from "vitest";
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
 * Task 5.3: `execute(dagId)` — main loop: for each wave, dispatch all steps
 * in parallel via `coordinator.delegate()` (NOT AsyncExecutor — DagExecutor
 * manages the wave loop directly), wait for all to complete, resolve template
 * vars for next wave, repeat.
 *
 * These tests cover the core execute() loop behavior:
 * - Single-step DAG (1 wave) dispatches via coordinator.delegate()
 * - Multi-wave DAG executes waves sequentially
 * - Steps within a wave are dispatched in parallel
 * - Template variables are resolved between waves (step output flows to next prompt)
 * - DAG status transitions to "running" then "completed" on success
 * - Step outputs are captured and persisted via DagStore
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
	const dagDir = mkdtempSync(join(tmpdir(), "dag-execute-"));
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

describe("DagExecutor.execute (task 5.3)", () => {
	it("dispatches a single-step DAG via coordinator.delegate()", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator, delegateSpy } = makeMockCoordinator({
			gemini: "Research complete",
		});

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Research X" },
		]));

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(1);
		expect(delegateSpy.mock.calls[0][0]).toBe("gemini");
		expect(delegateSpy.mock.calls[0][1]).toBe("Research X");
		expect(delegateSpy.mock.calls[0][2]).toBeUndefined();

		// Verify step output was captured
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["a"].output).toBe("Research complete");
	});

	it("transitions DAG status to running then completed", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makeMockCoordinator({ gemini: "done" });

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Do something" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.status).toBe("completed");
	});

	it("executes a 2-wave DAG sequentially (wave 1 before wave 2)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		// Track dispatch order
		const dispatchOrder: string[] = [];
		const delegateSpy = vi.fn(
			async (agentName: string, message: string) => {
				dispatchOrder.push(message);
				return { text: `output-for-${message}`, stopReason: "end_turn", sessionId: "sess-1" };
			},
		);
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
		]));

		await executor.execute(record.dagId);

		// "Step A" must be dispatched before "Step B"
		expect(dispatchOrder[0]).toBe("Step A");
		expect(dispatchOrder[1]).toBe("Step B");

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["b"].status).toBe("completed");
	});

	it("resolves template variables between waves", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const dispatchPrompts: string[] = [];
		const delegateSpy = vi.fn(
			async (_agentName: string, message: string) => {
				dispatchPrompts.push(message);
				if (dispatchPrompts.length === 1) {
					return { text: "JWT tokens are the answer", stopReason: "end_turn", sessionId: "s1" };
				}
				return { text: "Implementation done", stopReason: "end_turn", sessionId: "s2" };
			},
		);
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Research auth" },
			{ id: "b", agent: "gemini", prompt: "Implement based on {a.output}", dependsOn: ["a"] },
		]));

		await executor.execute(record.dagId);

		// The second dispatch should have the resolved template variable
		expect(dispatchPrompts[1]).toBe("Implement based on JWT tokens are the answer");
	});

	it("dispatches parallel steps within a wave concurrently", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		// Wave 1: ["b", "c"] should both be dispatched concurrently (both start before either finishes)
		let bStarted = false;
		let cStarted = false;
		let bothRunning = false;

		const delegateSpy = vi.fn(
			async (agentName: string, message: string) => {
				if (message === "Step B") {
					bStarted = true;
					if (cStarted) bothRunning = true;
					// Wait a tick to allow C to start
					await new Promise((r) => setTimeout(r, 10));
					return { text: "B done", stopReason: "end_turn", sessionId: "sb" };
				}
				if (message === "Step C") {
					cStarted = true;
					if (bStarted) bothRunning = true;
					await new Promise((r) => setTimeout(r, 10));
					return { text: "C done", stopReason: "end_turn", sessionId: "sc" };
				}
				return { text: "A done", stopReason: "end_turn", sessionId: "sa" };
			},
		);
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
			{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["a"] },
		]));

		await executor.execute(record.dagId);

		// Both steps in wave 2 should have been running at the same time
		expect(bothRunning).toBe(true);

		const final = store.get(record.dagId)!;
		expect(final.steps["b"].output).toBe("B done");
		expect(final.steps["c"].output).toBe("C done");
	});

	it("captures error on step failure", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(
			async (_agentName: string, _message: string) => {
				throw new Error("Agent timeout after 300000ms");
			},
		);
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Do something" },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["a"].error).toBe("Agent timeout after 300000ms");
		expect(final.status).toBe("failed");
	});

	it("resolves dag.args.* template variables", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const dispatchPrompts: string[] = [];
		const delegateSpy = vi.fn(
			async (_agentName: string, message: string) => {
				dispatchPrompts.push(message);
				return { text: "done", stopReason: "end_turn", sessionId: "s1" };
			},
		);
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Write in {dag.args.lang}" },
			],
			args: { lang: "TypeScript" },
		});

		await executor.execute(record.dagId);

		expect(dispatchPrompts[0]).toBe("Write in TypeScript");
	});

	it("updates currentWave on the DAG record during execution", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const { instance: coordinator } = makeMockCoordinator({ gemini: "done" });

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create(makeDagDefinition([
			{ id: "a", agent: "gemini", prompt: "Step A" },
			{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
			{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["a"] },
		]));

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		// All three steps completed across 2 waves.
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["b"].status).toBe("completed");
		expect(final.steps["c"].status).toBe("completed");
		expect(final.status).toBe("completed");
	});
});

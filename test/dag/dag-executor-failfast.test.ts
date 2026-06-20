import { describe, it, expect, vi } from "vitest";
import { DagExecutor } from "../../src/dag/dag-executor.js";
import { DagStore } from "../../src/dag/dag-store.js";
import { TemplateResolver } from "../../src/dag/template-resolver.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { createNoopLogger } from "../../src/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import type { AgentCoordinator } from "../../src/coordination/coordinator.js";

/**
 * Task 5.6: failFast logic (design.md D5; specs/dag-submission "DAG options
 * — failFast and maxRetries"; specs/dag-execution "DAG state transitions").
 *
 *  - `failFast: true` (default): a failed step marks all TRANSITIVE
 *    dependents as `skipped`, while independent branches continue executing.
 *  - `failFast: false`: a failed step is treated like an `after` gate —
 *    dependents still execute, receiving the error message as the resolved
 *    value of `{<failed-step>.output}`.
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-failfast-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

describe("DagExecutor failFast (task 5.6)", () => {
	it("failFast=true (default): marks all transitive dependents as skipped", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		// Chain a → b → c (needs gates). "a" fails. Both "b" and "c" must be
		// skipped transitively. Independent branch "d" still completes.
		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			if (msg === "Step A") throw new Error("a failed");
			return { text: `out:${msg}`, stopReason: "end_turn", sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["b"] },
				{ id: "d", agent: "gemini", prompt: "Step D" },
			],
			// failFast defaults to true
		});

		await executor.execute(record.dagId);

		// Only "a" (failed) and "d" (independent) dispatched.
		expect(delegateSpy).toHaveBeenCalledTimes(2);
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("skipped");
		expect(final.steps["c"].status).toBe("skipped");
		expect(final.steps["d"].status).toBe("completed");
	});

	it("failFast=false: dependents execute receiving error message as resolved {dep.output}", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const dispatchedPrompts: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			dispatchedPrompts.push(msg);
			if (msg === "Step A") throw new Error("a failed");
			return { text: `out:${msg}`, stopReason: "end_turn", sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// a → b (needs gate). With failFast=false, "b" still runs and receives
		// the failed dep's error text as {a.output}.
		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{
					id: "b",
					agent: "gemini",
					prompt: "Review {a.output}",
					dependsOn: ["a"],
					gate: "needs",
				},
			],
			options: { failFast: false },
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(2);
		expect(dispatchedPrompts[1]).toBe("Review a failed");
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("completed");
	});

	it("failFast=false: transitive chain executes end-to-end on failure output", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			if (msg === "Step A") throw new Error("a failed");
			return { text: `out:${msg}`, stopReason: "end_turn", sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// a → b → c, all needs gates, failFast=false. "a" fails but "b" and "c"
		// still execute (chained on the propagated failure output).
		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["b"] },
			],
			options: { failFast: false },
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(3);
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("completed");
		expect(final.steps["c"].status).toBe("completed");
	});
});

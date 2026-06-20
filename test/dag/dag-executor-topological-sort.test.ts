import { describe, it, expect } from "vitest";
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
 * Task 5.2: `topologicalSort(tasks)` — returns an ordered array of waves
 * (each wave = array of step IDs), aligned with design.md D2 (dorkestrator's
 * `buildExecutionWaves()` pattern).
 */

function makeExecutor() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-exec-topo-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const config = { agent_servers: {} } as never;
	const coordinator = new AgentCoordinator(config, process.cwd());
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });
}

function task(id: string, dependsOn: string[] = []): DagTaskDefinition {
	return { id, agent: "gemini", prompt: "x", dependsOn };
}

describe("DagExecutor.topologicalSort (task 5.2)", () => {
	it("returns an empty array for an empty task list", () => {
		const executor = makeExecutor();
		expect(executor.topologicalSort([])).toEqual([]);
	});

	it("returns a single wave for independent steps", () => {
		const executor = makeExecutor();
		const waves = executor.topologicalSort([
			task("a"),
			task("b"),
			task("c"),
		]);
		expect(waves).toEqual([["a", "b", "c"]]);
	});

	it("orders a linear chain into sequential waves", () => {
		const executor = makeExecutor();
		const waves = executor.topologicalSort([
			task("a"),
			task("b", ["a"]),
			task("c", ["b"]),
		]);
		expect(waves).toEqual([["a"], ["b"], ["c"]]);
	});

	it("groups parallel branches into the same wave", () => {
		// Diamond: a -> [b, c] -> d
		const executor = makeExecutor();
		const waves = executor.topologicalSort([
			task("a"),
			task("b", ["a"]),
			task("c", ["a"]),
			task("d", ["b", "c"]),
		]);
		expect(waves).toEqual([["a"], ["b", "c"], ["d"]]);
	});

	it("places a step in the wave right after its latest dependency", () => {
		// a, b independent; c depends on a; d depends on b and c.
		// waves: [a, b], [c], [d]  — c waits for a (wave 0); d waits for
		// b (wave 0) and c (wave 1) so d lands in wave 2.
		const executor = makeExecutor();
		const waves = executor.topologicalSort([
			task("a"),
			task("b"),
			task("c", ["a"]),
			task("d", ["b", "c"]),
		]);
		expect(waves).toEqual([["a", "b"], ["c"], ["d"]]);
	});

	it("is order-independent of the input task array", () => {
		const executor = makeExecutor();
		const waves = executor.topologicalSort([
			task("d", ["b", "c"]),
			task("c", ["a"]),
			task("b", ["a"]),
			task("a"),
		]);
		// Same diamond as above, just shuffled input. Wave GROUPING (which
		// ids belong together) must be identical regardless of input order;
		// within-wave element order follows the input declaration order and
		// is otherwise unspecified.
		expect(waves.map((w) => new Set(w))).toEqual([
			new Set(["a"]),
			new Set(["b", "c"]),
			new Set(["d"]),
		]);
	});

	it("does not mutate the input task array", () => {
		const executor = makeExecutor();
		const tasks = [task("a"), task("b", ["a"])];
		const snapshot = tasks.map((t) => ({ ...t, dependsOn: [...(t.dependsOn ?? [])] }));
		executor.topologicalSort(tasks);
		expect(tasks).toEqual(snapshot);
	});
});

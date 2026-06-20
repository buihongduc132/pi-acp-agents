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

/**
 * Task 5.1: Create `src/dag/dag-executor.ts` with `DagExecutor` class.
 *
 * These tests assert only the construction/import behavior for task 5.1,
 * including that the constructor wires up its existing-infrastructure
 * dependencies (per design.md and task 7.1): `AgentCoordinator`,
 * `AsyncExecutor`, `CircuitBreaker`, plus the DAG-layer collaborators
 * `DagStore` and `TemplateResolver`. The full execution surface
 * (topological sort / wave dispatch / gate evaluation / failFast /
 * circuit-breaker check / cancel / resume / stale detection / retry) is
 * covered by later tasks (5.2–5.13).
 */

function makeDeps() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-exec-ctor-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const config = {
		agent_servers: {},
	} as never;
	const coordinator = new AgentCoordinator(config, process.cwd());
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, coordinator, circuitBreaker, logger };
}

describe("DagExecutor (constructor — task 5.1)", () => {
	it("exports the DagExecutor class", () => {
		expect(typeof DagExecutor).toBe("function");
	});

	it("constructs a DagExecutor instance without throwing", () => {
		const deps = makeDeps();
		expect(() =>
			new DagExecutor({
				store: deps.store,
				resolver: deps.resolver,
				coordinator: deps.coordinator,
				circuitBreaker: deps.circuitBreaker,
				logger: deps.logger,
			}),
		).not.toThrow();
	});

	it("returns a DagExecutor instance", () => {
		const deps = makeDeps();
		const executor = new DagExecutor({
			store: deps.store,
			resolver: deps.resolver,
			coordinator: deps.coordinator,
			circuitBreaker: deps.circuitBreaker,
			logger: deps.logger,
		});
		expect(executor).toBeInstanceOf(DagExecutor);
	});

	it("exposes its wired dependencies on the instance", () => {
		const deps = makeDeps();
		const executor = new DagExecutor({
			store: deps.store,
			resolver: deps.resolver,
			coordinator: deps.coordinator,
			circuitBreaker: deps.circuitBreaker,
			logger: deps.logger,
		});
		// Dependencies are reachable so later tasks (5.2–5.13) and tool
		// wiring (task 7.1) can drive them through the executor.
		expect(executor.store).toBe(deps.store);
		expect(executor.resolver).toBe(deps.resolver);
		expect(executor.coordinator).toBe(deps.coordinator);
		expect(executor.circuitBreaker).toBe(deps.circuitBreaker);
	});
});

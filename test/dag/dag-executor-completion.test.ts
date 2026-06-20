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
import type { DagStepRecord, DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 5.8: DAG completion detection — when all steps reach a terminal
 * state, transition the DAG to `completed` or `failed`.
 *
 * These tests pin down the completion-detection behaviour in isolation:
 *  - `detectCompletion()` returns `null` while any step is still
 *    non-terminal (pending/running) — the DAG MUST NOT transition yet.
 *  - When every step is `completed`, it returns `"completed"`.
 *  - When at least one step is `failed` (and the rest terminal), it returns
 *    `"failed"`.
 *  - When at least one step is `skipped` (failFast skip) and the rest
 *    terminal, it returns `"failed"` (the run as a whole did not succeed).
 *  - A cancelled step is reported separately by the cancel path (task 5.9);
 *    here it still counts as a non-success terminal state.
 *  - The `execute()` loop calls `detectCompletion()` and transitions the
 *    persisted DAG record accordingly after the final wave.
 */

function makeExecutor() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-completion-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	const delegateSpy = vi.fn(async (agent: string) => ({
		text: `out-${agent}`,
		stopReason: "end_turn" as const,
		sessionId: "s1",
	}));
	const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
	const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });
	return { executor, store, delegateSpy, dagDir };
}

function makeStep(overrides: Partial<DagStepRecord>): DagStepRecord {
	return {
		id: overrides.id ?? "a",
		agent: overrides.agent ?? "gemini",
		prompt: overrides.prompt ?? "do",
		dependsOn: overrides.dependsOn ?? [],
		gate: overrides.gate ?? "needs",
		status: overrides.status ?? "pending",
		...overrides,
	};
}

describe("DagExecutor.detectCompletion (task 5.8)", () => {
	it("returns null while any step is still pending", () => {
		const { executor } = makeExecutor();
		const steps = {
			a: makeStep({ id: "a", status: "completed" }),
			b: makeStep({ id: "b", status: "pending" }),
		};
		expect(executor.detectCompletion(steps)).toBeNull();
	});

	it("returns null while any step is still running", () => {
		const { executor } = makeExecutor();
		const steps = {
			a: makeStep({ id: "a", status: "completed" }),
			b: makeStep({ id: "b", status: "running" }),
		};
		expect(executor.detectCompletion(steps)).toBeNull();
	});

	it("returns 'completed' when every step is completed", () => {
		const { executor } = makeExecutor();
		const steps = {
			a: makeStep({ id: "a", status: "completed" }),
			b: makeStep({ id: "b", status: "completed" }),
		};
		expect(executor.detectCompletion(steps)).toBe("completed");
	});

	it("returns 'failed' when at least one step failed and rest are terminal", () => {
		const { executor } = makeExecutor();
		const steps = {
			a: makeStep({ id: "a", status: "failed" }),
			b: makeStep({ id: "b", status: "completed" }),
		};
		expect(executor.detectCompletion(steps)).toBe("failed");
	});

	it("returns 'failed' when a step is skipped (failFast propagation)", () => {
		const { executor } = makeExecutor();
		const steps = {
			a: makeStep({ id: "a", status: "failed" }),
			b: makeStep({ id: "b", status: "skipped" }),
		};
		expect(executor.detectCompletion(steps)).toBe("failed");
	});

	it("returns 'failed' when a step is cancelled", () => {
		const { executor } = makeExecutor();
		const steps = {
			a: makeStep({ id: "a", status: "cancelled" }),
			b: makeStep({ id: "b", status: "completed" }),
		};
		expect(executor.detectCompletion(steps)).toBe("failed");
	});

	it("returns 'completed' for an empty step set (no steps to fail)", () => {
		const { executor } = makeExecutor();
		expect(executor.detectCompletion({})).toBe("completed");
	});
});

describe("DagExecutor.execute completion transition (task 5.8)", () => {
	it("transitions DAG to completed when all steps succeed", async () => {
		const { executor, store } = makeExecutor();
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "A" },
			{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
		];
		const record = store.create({ tasks });

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.status).toBe("completed");
		expect(final.completedAt).toBeTruthy();
	});

	it("transitions DAG to failed when a step fails", async () => {
		const dagDir = mkdtempSync(join(tmpdir(), "dag-completion-"));
		const store = new DagStore({
			dagDir,
			dagIndexFile: join(dagDir, "dag-index.json"),
		});
		const resolver = new TemplateResolver();
		const circuitBreaker = new AcpCircuitBreaker();
		const logger = createNoopLogger();
		const delegateSpy = vi.fn(async () => {
			throw new Error("boom");
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "A" },
			{ id: "b", agent: "gemini", prompt: "B", dependsOn: ["a"] },
		];
		const record = store.create({ tasks });

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("skipped");
		expect(final.status).toBe("failed");
		expect(final.completedAt).toBeTruthy();
	});
});

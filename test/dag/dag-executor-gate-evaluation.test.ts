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
 * Task 5.5: gate evaluation — `needs` gate: downstream only if dep
 * `completed`; `after` gate: downstream if dep in terminal state regardless
 * of outcome (design.md D4; specs/dag-submission "Gate types — needs and
 * after").
 *
 * These tests pin the gate decision the wave loop makes before dispatching a
 * step:
 *  - `needs` gate + dep `completed`  → step dispatched (status `completed`)
 *  - `needs` gate + dep `failed`     → step NOT dispatched, marked `skipped`
 *  - `after` gate + dep `completed`  → step dispatched normally
 *  - `after` gate + dep `failed`     → step dispatched regardless, receives
 *    the dep's error message as `{<dep>.output}`
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-gate-eval-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

describe("DagExecutor gate evaluation (task 5.5)", () => {
	it("needs gate: downstream dispatched when dependency completed", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, _msg: string) => ({
			text: "ok",
			stopReason: "end_turn",
			sessionId: "s1",
		}));
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"], gate: "needs" },
			],
		});

		await executor.execute(record.dagId);

		// Both steps dispatched: dep "a" completed ⇒ needs gate satisfied.
		expect(delegateSpy).toHaveBeenCalledTimes(2);
		const final = store.get(record.dagId)!;
		expect(final.steps["b"].status).toBe("completed");
	});

	it("needs gate: downstream skipped (not dispatched) when dependency failed", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			if (msg === "Step A") throw new Error("a failed");
			return { text: "b output", stopReason: "end_turn", sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{
					id: "b",
					agent: "gemini",
					prompt: "Step B",
					dependsOn: ["a"],
					gate: "needs",
				},
			],
		});

		await executor.execute(record.dagId);

		// Only "a" was dispatched — "b" blocked by needs gate and skipped.
		expect(delegateSpy).toHaveBeenCalledTimes(1);
		expect(delegateSpy.mock.calls[0][0]).toBe("gemini");
		expect(delegateSpy.mock.calls[0][1]).toBe("Step A");

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("skipped");
		expect(final.steps["b"].output).toBeNull();
	});

	it("after gate: downstream dispatched normally when dependency completed", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, msg: string) => ({
			text: `out:${msg}`,
			stopReason: "end_turn",
			sessionId: "s",
		}));
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{
					id: "b",
					agent: "gemini",
					prompt: "Step B",
					dependsOn: ["a"],
					gate: "after",
				},
			],
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(2);
		const final = store.get(record.dagId)!;
		expect(final.steps["b"].status).toBe("completed");
	});

	it("after gate: downstream dispatched regardless when dependency failed, receiving error as {dep.output}", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const dispatchedPrompts: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			dispatchedPrompts.push(msg);
			if (msg === "Step A") throw new Error("a failed");
			return { text: "b output", stopReason: "end_turn", sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{
					id: "b",
					agent: "gemini",
					prompt: "Review {a.output}",
					dependsOn: ["a"],
					gate: "after",
				},
			],
		});

		await executor.execute(record.dagId);

		// Both dispatched — after gate proceeds regardless of dep outcome.
		expect(delegateSpy).toHaveBeenCalledTimes(2);
		// Downstream prompt received the failed dep's error message as {a.output}.
		expect(dispatchedPrompts[1]).toBe("Review a failed");

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["b"].status).toBe("completed");
	});

	it("needs gate is the default when gate omitted and dep failed → downstream skipped", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, msg: string) => {
			if (msg === "Step A") throw new Error("boom");
			return { text: "b", stopReason: "end_turn", sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
			],
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(1);
		const final = store.get(record.dagId)!;
		expect(final.steps["b"].status).toBe("skipped");
	});
});

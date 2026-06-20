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
 * Task 5.7: circuit breaker check — before dispatching a step, check agent
 * health via `CircuitBreaker`; if open, fail the step immediately.
 *
 * Specs/dag-execution "Step dispatch via AgentCoordinator":
 *   - WHEN step "a" is assigned to agent "gemini" but the circuit breaker is open
 *   - THEN the step SHALL fail with error:
 *     `Agent "gemini" is unavailable (circuit breaker open)`
 *
 * Design.md R3 / D-Integration: the executor consults `AcpCircuitBreaker`
 * before every dispatch; an open circuit short-circuits the step to `failed`
 * WITHOUT calling `coordinator.delegate()`.
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-cb-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	// Large reset timeout so the open circuit stays open for the whole test.
	const circuitBreaker = new AcpCircuitBreaker(/* maxFailures */ 3, /* resetTimeoutMs */ 60_000);
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

describe("DagExecutor circuit breaker check (task 5.7)", () => {
	it("fails the step immediately without dispatching when the agent circuit is open", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async () => ({
			text: "should not be called",
			stopReason: "end_turn",
			sessionId: "s1",
		}));
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// Trip the circuit breaker for agent "gemini".
		circuitBreaker.recordFailure("gemini");
		circuitBreaker.recordFailure("gemini");
		circuitBreaker.recordFailure("gemini");
		expect(circuitBreaker.isHealthy("gemini")).toBe(false);

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
		});

		await executor.execute(record.dagId);

		// The delegate MUST NOT be called — the open circuit short-circuited it.
		expect(delegateSpy).not.toHaveBeenCalled();

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["a"].error).toBe(
			'Agent "gemini" is unavailable (circuit breaker open)',
		);
		expect(final.steps["a"].output).toBeNull();
	});

	it("dispatches normally when the agent circuit is healthy (closed)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async () => ({
			text: "ok",
			stopReason: "end_turn",
			sessionId: "s1",
		}));
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// Healthy agent: no recorded failures.
		expect(circuitBreaker.isHealthy("gemini")).toBe(true);

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(1);
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
	});

	it("fails only the open-circuit step while healthy agents in the same wave still dispatch", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, msg: string) => ({
			text: `out:${msg}`,
			stopReason: "end_turn",
			sessionId: "s1",
		}));
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// Trip "gemini" only; "codex" stays healthy.
		circuitBreaker.recordFailure("gemini");
		circuitBreaker.recordFailure("gemini");
		circuitBreaker.recordFailure("gemini");

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "codex", prompt: "Step B" },
			],
		});

		await executor.execute(record.dagId);

		// "b" dispatched once; "a" never dispatched.
		expect(delegateSpy).toHaveBeenCalledTimes(1);
		expect(delegateSpy.mock.calls[0][0]).toBe("codex");
		expect(delegateSpy.mock.calls[0][1]).toBe("Step B");

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["a"].error).toBe(
			'Agent "gemini" is unavailable (circuit breaker open)',
		);
		expect(final.steps["b"].status).toBe("completed");
	});
});

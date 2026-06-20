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
 * Task 5.12: step retry logic (design.md D5; specs/dag-submission "DAG
 * options — failFast and maxRetries").
 *
 * On failure, when `options.maxRetries > 0` and the step's `retryCount` is
 * less than `maxRetries`, the executor resets the step to `pending` and
 * re-dispatches it, incrementing `retryCount` on the `DagStepRecord`. Once
 * the retry budget is exhausted the step stays `failed`.
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-retry-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

describe("DagExecutor retry (task 5.12)", () => {
	it("retries on failure up to maxRetries and tracks retryCount on success", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		// Fail the first dispatch, succeed on the retry.
		const delegateSpy = vi.fn(async (_agent: string, _msg: string) => {
			if (delegateSpy.mock.calls.length === 1) {
				throw new Error("transient failure");
			}
			return { text: "ok", stopReason: "end_turn", sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
			options: { maxRetries: 1 },
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(2);
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["a"].output).toBe("ok");
		expect(final.steps["a"].retryCount).toBe(1);
	});

	it("stops retrying once retryCount reaches maxRetries and stays failed", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		// Always fails — should exhaust retries (maxRetries=1 ⇒ at most 2
		// attempts total: the initial dispatch + 1 retry).
		const delegateSpy = vi.fn(async () => {
			throw new Error("permanent failure");
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
			options: { maxRetries: 1 },
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(2);
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["a"].error).toBe("permanent failure");
		expect(final.steps["a"].retryCount).toBe(1);
	});

	it("does not retry when maxRetries is 0 (default)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async () => {
			throw new Error("no retries allowed");
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
			// maxRetries defaults to 0 — no retries
		});

		await executor.execute(record.dagId);

		expect(delegateSpy).toHaveBeenCalledTimes(1);
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		// No retries occurred — retryCount stays at its initialized 0.
		expect(final.steps["a"].retryCount).toBe(0);
	});
});

import { describe, it, expect, vi } from "vitest";
import { DagExecutor } from "../../src/dag/dag-executor.js";
import { DagStore } from "../../src/dag/dag-store.js";
import { TemplateResolver } from "../../src/dag/template-resolver.js";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { createNoopLogger } from "../../src/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AgentCoordinator as AgentCoordinatorType } from "../../src/coordination/coordinator.js";

/**
 * Task 5.4: wave dispatch — each step in a wave dispatched via
 * `coordinator.delegate(agent, resolvedPrompt, cwd)`; explicitly capture
 * and store step output (text on success, error on failure) in
 * `DagStepRecord` via `DagStore.updateStep()`.
 *
 * These tests pin the per-step dispatch contract that the wave loop relies
 * on: the delegate call signature, the success path (output captured &
 * persisted), the failure path (error captured, output null), the running
 * transition, duration capture, and that the persisted on-disk file reflects
 * the captured values (proving the storage path goes through
 * `DagStore.updateStep`).
 */

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-wave-dispatch-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

describe("DagExecutor wave dispatch (task 5.4)", () => {
	it("dispatches each step via coordinator.delegate(agent, resolvedPrompt, cwd)", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, _msg: string, _cwd?: string) => ({
			text: "ok",
			stopReason: "end_turn",
			sessionId: "s1",
		}));
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinatorType;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "codex", prompt: "Step B", dependsOn: ["a"] },
			],
		});

		await executor.execute(record.dagId);

		// Each step dispatched exactly once, with (agent, resolvedPrompt, cwd).
		expect(delegateSpy).toHaveBeenCalledTimes(2);
		expect(delegateSpy.mock.calls[0][0]).toBe("gemini");
		expect(delegateSpy.mock.calls[0][1]).toBe("Step A");
		expect(delegateSpy.mock.calls[1][0]).toBe("codex");
		expect(delegateSpy.mock.calls[1][1]).toBe("Step B");
	});

	it("captures and persists step output text on success via DagStore.updateStep", async () => {
		const { store, resolver, circuitBreaker, logger, dagDir } = makeSetup();

		const delegateSpy = vi.fn(async () => ({
			text: "Research findings: ...",
			stopReason: "end_turn",
			sessionId: "s1",
		}));
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinatorType;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Research X" }],
		});

		await executor.execute(record.dagId);

		// 1. In-memory record reflects captured output.
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
		expect(final.steps["a"].output).toBe("Research findings: ...");
		expect(final.steps["a"].error).toBeUndefined();

		// 2. On-disk file reflects the same — proves the capture went through
		//    DagStore.updateStep()'s persistence path, not just an in-memory mutation.
		const onDisk = JSON.parse(readFileSync(join(dagDir, `${record.dagId}.json`), "utf8"));
		expect(onDisk.steps.a.status).toBe("completed");
		expect(onDisk.steps.a.output).toBe("Research findings: ...");
	});

	it("captures error message and nulls output on failure", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async () => {
			throw new Error("Agent timeout after 300000ms");
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinatorType;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do work" }],
		});

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("failed");
		expect(final.steps["a"].error).toBe("Agent timeout after 300000ms");
		expect(final.steps["a"].output).toBeNull();
	});

	it("transitions step through running before reaching terminal state", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		let observedRunning = false;
		const delegateSpy = vi.fn(async () => {
			// While the step is in-flight, the persisted record must show "running".
			const inFlight = store.get(/* dagId injected below */ (delegateSpy as any).__dagId)!;
			if (inFlight.steps["a"].status === "running") observedRunning = true;
			return { text: "done", stopReason: "end_turn", sessionId: "s1" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinatorType;

		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Work" }],
		});
		(delegateSpy as any).__dagId = record.dagId;

		await executor.execute(record.dagId);

		expect(observedRunning).toBe(true);
		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");
	});

	it("records durationMs on both success and failure terminal transitions", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();

		const delegateSpy = vi.fn(async (_agent: string, _msg: string) => {
			await new Promise((r) => setTimeout(r, 5));
			return { text: "done", stopReason: "end_turn", sessionId: "s1" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinatorType;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		const record = store.create({
			tasks: [
				{ id: "ok", agent: "gemini", prompt: "ok" },
				{ id: "boom", agent: "codex", prompt: "boom" },
			],
		});

		// Make "boom" fail.
		delegateSpy.mockImplementation(async (_agent: string, msg: string) => {
			await new Promise((r) => setTimeout(r, 5));
			if (msg === "boom") throw new Error("kaput");
			return { text: "ok", stopReason: "end_turn", sessionId: "s" };
		});

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		expect(typeof final.steps["ok"].durationMs).toBe("number");
		expect(final.steps["ok"].durationMs!).toBeGreaterThanOrEqual(0);
		expect(typeof final.steps["boom"].durationMs).toBe("number");
		expect(final.steps["boom"].durationMs!).toBeGreaterThanOrEqual(0);
	});
});

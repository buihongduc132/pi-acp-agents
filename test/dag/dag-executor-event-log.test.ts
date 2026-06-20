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
 * Task 7.4: Wire DAG step events to existing `AcpEventLog` — log `dag-step`
 * events for each step lifecycle transition (start, complete, fail, skip,
 * cancel) with type "dag-step" and data including `dagId`, `stepId`,
 * `agent`, `status`, and `durationMs` (where applicable).
 *
 * These tests verify that the DagExecutor:
 * - Accepts an optional `eventLog` dependency in constructor
 * - Logs "dag-step" events for step start, complete, fail, skip, cancel
 * - Includes dagId, stepId, agent, status, and durationMs in event data
 * - Does not throw or break when eventLog is absent (backward compatible)
 */

function makeMockCoordinator(
	responses: Record<string, string>,
	failureAgents?: Set<string>,
): { instance: AgentCoordinator; delegateSpy: ReturnType<typeof vi.fn> } {
	const delegateSpy = vi.fn(
		async (agentName: string, _message: string, _cwd?: string, _n?: unknown, signal?: AbortSignal) => {
			// Simulate cancellation via signal
			if (signal?.aborted) {
				const err = new DOMException("The operation was aborted.", "AbortError");
				throw err;
			}
			if (failureAgents?.has(agentName)) {
				throw new Error(`agent ${agentName} failed`);
			}
			const text = responses[agentName] ?? `response from ${agentName}`;
			return { text, stopReason: "end_turn", sessionId: `sess-${agentName}` };
		},
	);
	const instance = { delegate: delegateSpy } as unknown as AgentCoordinator;
	return { instance, delegateSpy };
}

function makeMockEventLog() {
	const appendSpy = vi.fn();
	return {
		instance: { append: appendSpy },
		appendSpy,
	};
}

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-event-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

describe("DagExecutor event logging (task 7.4)", () => {
	let store: DagStore;
	let resolver: TemplateResolver;
	let circuitBreaker: AcpCircuitBreaker;

	beforeEach(() => {
		const setup = makeSetup();
		store = setup.store;
		resolver = setup.resolver;
		circuitBreaker = setup.circuitBreaker;
	});

	it("logs dag-step event with status=running when a step starts execution", async () => {
		const { instance: coordinator } = makeMockCoordinator({ gemini: "done" });
		const { instance: eventLog, appendSpy } = makeMockEventLog();

		const executor = new DagExecutor({
			store, resolver, coordinator, circuitBreaker,
			logger: createNoopLogger(),
			eventLog,
		});

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do something" }],
		});

		await executor.execute(record.dagId);

		// Verify at least one dag-step event with status "running"
		const runningEvents = appendSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "dag-step" && (call[1] as { status: string }).status === "running",
		);
		expect(runningEvents.length).toBeGreaterThanOrEqual(1);

		const eventData = runningEvents[0][1] as Record<string, unknown>;
		expect(eventData.dagId).toBe(record.dagId);
		expect(eventData.stepId).toBe("a");
		expect(eventData.agent).toBe("gemini");
		expect(eventData.status).toBe("running");
		expect(eventData.timestamp).toBeDefined();
	});

	it("logs dag-step event with status=completed and durationMs when a step completes", async () => {
		const { instance: coordinator } = makeMockCoordinator({ gemini: "output text" });
		const { instance: eventLog, appendSpy } = makeMockEventLog();

		const executor = new DagExecutor({
			store, resolver, coordinator, circuitBreaker,
			logger: createNoopLogger(),
			eventLog,
		});

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do something" }],
		});

		await executor.execute(record.dagId);

		// Verify a dag-step event with status "completed"
		const completedEvents = appendSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "dag-step" && (call[1] as { status: string }).status === "completed",
		);
		expect(completedEvents.length).toBe(1);

		const eventData = completedEvents[0][1] as Record<string, unknown>;
		expect(eventData.dagId).toBe(record.dagId);
		expect(eventData.stepId).toBe("a");
		expect(eventData.status).toBe("completed");
		expect(typeof eventData.durationMs).toBe("number");
	});

	it("logs dag-step event with status=failed when a step fails", async () => {
		const failureAgents = new Set(["gemini"]);
		const { instance: coordinator } = makeMockCoordinator({}, failureAgents);
		const { instance: eventLog, appendSpy } = makeMockEventLog();

		const executor = new DagExecutor({
			store, resolver, coordinator, circuitBreaker,
			logger: createNoopLogger(),
			eventLog,
		});

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do something" }],
		});

		await executor.execute(record.dagId);

		// Verify a dag-step event with status "failed"
		const failedEvents = appendSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "dag-step" && (call[1] as { status: string }).status === "failed",
		);
		expect(failedEvents.length).toBe(1);

		const eventData = failedEvents[0][1] as Record<string, unknown>;
		expect(eventData.dagId).toBe(record.dagId);
		expect(eventData.stepId).toBe("a");
		expect(eventData.status).toBe("failed");
		expect(typeof eventData.durationMs).toBe("number");
	});

	it("logs dag-step event with status=skipped when a step is skipped due to gate", async () => {
		const { instance: coordinator } = makeMockCoordinator({});
		// Make gemini fail so step "b" (depends on "a") gets skipped
		const failureAgents = new Set(["gemini"]);
		const { instance: failCoordinator } = makeMockCoordinator({}, failureAgents);
		const { instance: eventLog, appendSpy } = makeMockEventLog();

		const executor = new DagExecutor({
			store, resolver, coordinator: failCoordinator, circuitBreaker,
			logger: createNoopLogger(),
			eventLog,
		});

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Research" },
				{ id: "b", agent: "gemini", prompt: "Code based on {a.output}", dependsOn: ["a"], gate: "needs" },
			],
			options: { failFast: true },
		});

		await executor.execute(record.dagId);

		// Verify a dag-step event with status "skipped"
		const skippedEvents = appendSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "dag-step" && (call[1] as { status: string }).status === "skipped",
		);
		expect(skippedEvents.length).toBeGreaterThanOrEqual(1);

		const eventData = skippedEvents[0][1] as Record<string, unknown>;
		expect(eventData.dagId).toBe(record.dagId);
		expect(eventData.stepId).toBe("b");
		expect(eventData.status).toBe("skipped");
	});

	it("logs dag-step event with status=cancelled when a step is cancelled", async () => {
		// Use a never-resolving delegate so we can cancel mid-flight
		const delegateSpy = vi.fn(() => new Promise((_resolve, reject) => {
			// Register abort listener
			const timer = setTimeout(() => {}, 60_000);
			// We rely on the signal being forwarded — but coordinator mock
			// receives the signal as the 5th arg
		}));
		// More direct: use a delegate that waits forever
		const longDelegate = vi.fn(
			async (_agent: string, _msg: string, _cwd?: string, _n?: unknown, signal?: AbortSignal) => {
				return new Promise((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					const onAbort = () => {
						reject(new DOMException("Aborted", "AbortError"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });
				});
			},
		);
		const coordinator = { delegate: longDelegate } as unknown as AgentCoordinator;
		const { instance: eventLog, appendSpy } = makeMockEventLog();

		const executor = new DagExecutor({
			store, resolver, coordinator, circuitBreaker,
			logger: createNoopLogger(),
			eventLog,
		});

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Long running task" }],
		});

		// Start execution in background, then cancel
		const execPromise = executor.execute(record.dagId);

		// Wait until the step is running
		await vi.waitFor(() => {
			const r = store.get(record.dagId)!;
			expect(r.steps["a"].status).toBe("running");
		}, { timeout: 2000 });

		await executor.cancel(record.dagId);
		await execPromise.catch(() => {}); // swallow

		// Verify a dag-step event with status "cancelled"
		const cancelledEvents = appendSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "dag-step" && (call[1] as { status: string }).status === "cancelled",
		);
		expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);

		const eventData = cancelledEvents[0][1] as Record<string, unknown>;
		expect(eventData.dagId).toBe(record.dagId);
		expect(eventData.stepId).toBe("a");
		expect(eventData.status).toBe("cancelled");
	});

	it("does not throw when eventLog is not provided (backward compatible)", async () => {
		const { instance: coordinator } = makeMockCoordinator({ gemini: "done" });

		// No eventLog in options
		const executor = new DagExecutor({
			store, resolver, coordinator, circuitBreaker,
			logger: createNoopLogger(),
		});

		const record = store.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "Do something" }],
		});

		// Should not throw
		await expect(executor.execute(record.dagId)).resolves.toBeUndefined();

		const final = store.get(record.dagId)!;
		expect(final.status).toBe("completed");
	});

	it("logs events for every step in a multi-wave DAG", async () => {
		const { instance: coordinator } = makeMockCoordinator({ gemini: "done" });
		const { instance: eventLog, appendSpy } = makeMockEventLog();

		const executor = new DagExecutor({
			store, resolver, coordinator, circuitBreaker,
			logger: createNoopLogger(),
			eventLog,
		});

		const record = store.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "First" },
				{ id: "b", agent: "gemini", prompt: "Second based on {a.output}", dependsOn: ["a"] },
			],
		});

		await executor.execute(record.dagId);

		// Should have dag-step events for both step "a" and "b"
		const dagStepEvents = appendSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "dag-step",
		);

		const stepIds = dagStepEvents.map((call: unknown[]) => (call[1] as { stepId: string }).stepId);
		expect(stepIds).toContain("a");
		expect(stepIds).toContain("b");

		// Each step should have a "running" + terminal ("completed") event pair
		const aRunning = dagStepEvents.filter((call: unknown[]) => (call[1] as any).stepId === "a" && (call[1] as any).status === "running");
		const aCompleted = dagStepEvents.filter((call: unknown[]) => (call[1] as any).stepId === "a" && (call[1] as any).status === "completed");
		expect(aRunning.length).toBe(1);
		expect(aCompleted.length).toBe(1);

		const bRunning = dagStepEvents.filter((call: unknown[]) => (call[1] as any).stepId === "b" && (call[1] as any).status === "running");
		const bCompleted = dagStepEvents.filter((call: unknown[]) => (call[1] as any).stepId === "b" && (call[1] as any).status === "completed");
		expect(bRunning.length).toBe(1);
		expect(bCompleted.length).toBe(1);
	});
});

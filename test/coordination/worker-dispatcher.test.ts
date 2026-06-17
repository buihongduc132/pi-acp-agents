/**
 * TDD tests for WorkerDispatcher (M6: Auto-Claim Dispatch)
 * Tasks 7.3, 7.4, 7.5, 7.12, 7.13
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerDispatcher, type WorkerDispatcherDeps } from "../../src/coordination/worker-dispatcher.js";
import type { AcpWorkerRecord } from "../../src/config/types.js";

function makeWorker(name: string, status: AcpWorkerRecord["status"] = "idle", currentTaskId?: string): AcpWorkerRecord {
	const now = new Date().toISOString();
	return {
		name,
		sessionId: "ses-1",
		agentName: "gemini",
		status,
		currentTaskId,
		spawnedAt: now,
		lastActivityAt: now,
		metadata: {},
	};
}

function makeWorkerStore(workers: AcpWorkerRecord[] = []) {
	return {
		list: vi.fn((opts?: { status?: string }) => {
			if (opts?.status) return workers.filter((w) => w.status === opts.status);
			return workers;
		}),
		updateStatus: vi.fn((name: string, status: AcpWorkerRecord["status"]) => makeWorker(name, status)),
		assignTask: vi.fn(),
		unassignTask: vi.fn((name: string) => makeWorker(name)),
		get: vi.fn((name: string) => workers.find((w) => w.name === name)),
		updateMetadata: vi.fn((name: string) => makeWorker(name)),
	};
}

function createMockDeps(overrides?: Partial<WorkerDispatcherDeps>): WorkerDispatcherDeps {
	const claimedTasks = [
		{ id: "task-1", subject: "Implement feature X", description: "Do X" },
		{ id: "task-2", subject: "Implement feature Y", description: "Do Y" },
	];
	let claimIndex = 0;

	return {
		workerStore: makeWorkerStore(),
		taskStore: {
			claimNextAvailable: vi.fn(async () => {
				if (claimIndex < claimedTasks.length) return claimedTasks[claimIndex++]!;
				return null;
			}),
			update: vi.fn(async () => {}),
		},
		eventLog: {
			append: vi.fn(),
		},
		busySessions: new Map(),
		getSessionIdForWorker: vi.fn(() => "ses-1"),
		dispatchTask: vi.fn(async () => ({ ok: true, value: "done" })),
		...overrides,
	};
}

describe("WorkerDispatcher", () => {
	it("7.3: dispatchOnce claims unblocked task for idle worker", async () => {
		const deps = createMockDeps({
			workerStore: makeWorkerStore([makeWorker("worker-1", "idle")]),
		});
		const dispatcher = new WorkerDispatcher(deps, 5000);
		await dispatcher.dispatchOnce();

		expect(deps.taskStore.claimNextAvailable).toHaveBeenCalledTimes(1);
		expect(deps.workerStore.assignTask).toHaveBeenCalledWith("worker-1", "task-1");
		expect(deps.workerStore.updateStatus).toHaveBeenCalledWith("worker-1", "busy");
		expect(deps.eventLog.append).toHaveBeenCalledWith("task_assigned", expect.objectContaining({ workerName: "worker-1", taskId: "task-1" }));
	});

	it("7.4: dispatchOnce skips busy workers", async () => {
		const busyWorker = makeWorker("worker-busy", "busy", "task-existing");
		const idleWorker = makeWorker("worker-idle", "idle");
		const deps = createMockDeps({
			workerStore: makeWorkerStore([busyWorker, idleWorker]),
		});
		const dispatcher = new WorkerDispatcher(deps, 5000);
		await dispatcher.dispatchOnce();

		// Should have dispatched to idle worker only
		expect(deps.workerStore.assignTask).toHaveBeenCalledWith("worker-idle", "task-1");
		expect(deps.eventLog.append).toHaveBeenCalledWith("task_assigned", expect.objectContaining({ workerName: "worker-idle" }));
	});

	it("7.4: dispatchOnce skips workers with in-flight sessions", async () => {
		const idleWorker = makeWorker("worker-1", "idle");
		const deps = createMockDeps({
			workerStore: makeWorkerStore([idleWorker]),
			busySessions: new Map([["ses-1", true]]),
			getSessionIdForWorker: vi.fn(() => "ses-1"),
		});
		const dispatcher = new WorkerDispatcher(deps, 5000);
		await dispatcher.dispatchOnce();

		// Should NOT dispatch because session is busy
		expect(deps.taskStore.claimNextAvailable).not.toHaveBeenCalled();
		expect(deps.workerStore.assignTask).not.toHaveBeenCalled();
	});

	it("7.5: dispatcher returns to idle after task completion", async () => {
		const deps = createMockDeps({
			workerStore: makeWorkerStore([makeWorker("worker-1", "idle")]),
			dispatchTask: vi.fn(async () => ({ ok: true, value: "result text" })),
		});
		const dispatcher = new WorkerDispatcher(deps, 5000);
		await dispatcher.dispatchOnce();

		// Wait for async completion
		await new Promise((r) => setTimeout(r, 50));

		expect(deps.workerStore.updateStatus).toHaveBeenCalledWith("worker-1", "busy");
		expect(deps.workerStore.updateStatus).toHaveBeenCalledWith("worker-1", "idle");
		expect(deps.workerStore.unassignTask).toHaveBeenCalledWith("worker-1");
		expect(deps.eventLog.append).toHaveBeenCalledWith("task_completed", expect.objectContaining({ workerName: "worker-1" }));
		expect(deps.taskStore.update).toHaveBeenCalledWith("task-1", expect.any(Function));
	});

	it("7.12/7.13: round-robin dispatches tasks to different workers", async () => {
		const workers = [
			makeWorker("worker-a", "idle"),
			makeWorker("worker-b", "idle"),
		];
		const tasks = [
			{ id: "task-1", subject: "Task 1", description: null },
			{ id: "task-2", subject: "Task 2", description: null },
		];
		let taskIdx = 0;

		const deps = createMockDeps({
			workerStore: makeWorkerStore(workers),
			taskStore: {
				claimNextAvailable: vi.fn(async () => {
					if (taskIdx < tasks.length) return tasks[taskIdx++]!;
					return null;
				}),
				update: vi.fn(async () => {}),
			},
			dispatchTask: vi.fn(async () => ({ ok: true })),
		});
		const dispatcher = new WorkerDispatcher(deps, 5000);

		// First dispatch
		await dispatcher.dispatchOnce();
		expect(deps.workerStore.assignTask).toHaveBeenLastCalledWith("worker-a", "task-1");

		// Second dispatch
		await dispatcher.dispatchOnce();
		expect(deps.workerStore.assignTask).toHaveBeenLastCalledWith("worker-b", "task-2");
	});

	it("start() and stop() control the interval", () => {
		const deps = createMockDeps();
		const dispatcher = new WorkerDispatcher(deps, 50);
		expect(dispatcher.isRunning).toBe(false);

		dispatcher.start();
		expect(dispatcher.isRunning).toBe(true);

		dispatcher.stop();
		expect(dispatcher.isRunning).toBe(false);
	});

	it("no-op when no idle workers", async () => {
		const deps = createMockDeps({
			workerStore: makeWorkerStore([]),
		});
		const dispatcher = new WorkerDispatcher(deps, 5000);
		await dispatcher.dispatchOnce();

		expect(deps.taskStore.claimNextAvailable).not.toHaveBeenCalled();
	});
});

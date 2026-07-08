/**
 * RED tests for src/hooks/trigger-wiring.ts
 * Tests HookTriggerManager — wraps SessionManager/WorkerDispatcher/HealthMonitor
 * callbacks and fires hook events at correct lifecycle points.
 * Source does NOT exist yet — these MUST FAIL (RED phase).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HookTriggerManager } from "../../src/hooks/trigger-wiring.js";
import type { HookEventName, HookContext } from "../../src/hooks/types.js";

// --- Mock interfaces (stubs for SessionManager, WorkerDispatcher, HealthMonitor) ---

function createMockSessionManager() {
	return {
		add: vi.fn(),
		remove: vi.fn(),
	};
}

function createMockWorkerDispatcher() {
	return {
		dispatchOnce: vi.fn(),
		handleDispatchResult: vi.fn(),
		dispatch: vi.fn(),
	};
}

function createMockHealthMonitor() {
	return {
		check: vi.fn(),
	};
}

function createMockHookDispatcher() {
	return {
		fire: vi.fn().mockResolvedValue(undefined),
	};
}

describe("HookTriggerManager", () => {
	let sessionManager: ReturnType<typeof createMockSessionManager>;
	let workerDispatcher: ReturnType<typeof createMockWorkerDispatcher>;
	let healthMonitor: ReturnType<typeof createMockHealthMonitor>;
	let hookDispatcher: ReturnType<typeof createMockHookDispatcher>;
	let manager: HookTriggerManager;

	beforeEach(() => {
		sessionManager = createMockSessionManager();
		workerDispatcher = createMockWorkerDispatcher();
		healthMonitor = createMockHealthMonitor();
		hookDispatcher = createMockHookDispatcher();

		manager = new HookTriggerManager({
			sessionManager: sessionManager as any,
			workerDispatcher: workerDispatcher as any,
			healthMonitor: healthMonitor as any,
			hookDispatcher: hookDispatcher as any,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("session lifecycle", () => {
		it("SessionManager.add() fires session_started event", async () => {
			const sessionData = {
				id: "sess-001",
				agent: "pi",
				cwd: "/tmp/project",
			};

			await manager.onSessionAdded(sessionData);

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"session_started",
				expect.objectContaining({
					event: "session_started",
					session: expect.objectContaining({ id: "sess-001" }),
				}),
			);
		});

		it("SessionManager.remove() fires session_completed on normal exit", async () => {
			const sessionData = {
				id: "sess-002",
				agent: "pi",
				cwd: "/tmp/project",
			};

			await manager.onSessionRemoved(sessionData, { error: false });

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"session_completed",
				expect.objectContaining({
					event: "session_completed",
					session: expect.objectContaining({ id: "sess-002" }),
				}),
			);
		});

		it("SessionManager.remove() fires session_failed on error", async () => {
			const sessionData = {
				id: "sess-003",
				agent: "pi",
				cwd: "/tmp/project",
			};

			await manager.onSessionRemoved(sessionData, {
				error: true,
				errorMessage: "crash",
			});

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"session_failed",
				expect.objectContaining({
					event: "session_failed",
					session: expect.objectContaining({ id: "sess-003" }),
				}),
			);
		});
	});

	describe("task lifecycle", () => {
		it("WorkerDispatcher dispatchOnce() fires task_assigned event", async () => {
			const taskData = {
				id: "task-001",
				subject: "Implement feature X",
				status: "in_progress",
				owner: "coder",
			};

			await manager.onTaskDispatched(taskData);

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"task_assigned",
				expect.objectContaining({
					event: "task_assigned",
					task: expect.objectContaining({ id: "task-001" }),
				}),
			);
		});

		it("WorkerDispatcher handleDispatchResult() fires task_completed on success", async () => {
			const resultData = {
				taskId: "task-002",
				success: true,
				durationMs: 1500,
			};

			await manager.onTaskResult(resultData);

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"task_completed",
				expect.objectContaining({
					event: "task_completed",
					task: expect.objectContaining({
						id: "task-002",
						status: "completed",
					}),
				}),
			);
		});

		it("WorkerDispatcher handleDispatchResult() fires task_failed on error", async () => {
			const resultData = {
				taskId: "task-003",
				success: false,
				error: "timeout exceeded",
				durationMs: 30000,
			};

			await manager.onTaskResult(resultData);

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"task_failed",
				expect.objectContaining({
					event: "task_failed",
					task: expect.objectContaining({
						id: "task-003",
						status: "failed",
					}),
				}),
			);
		});
	});

	describe("health monitor", () => {
		it("HealthMonitor check() stale fires session_idle event", async () => {
			const staleSession = {
				id: "sess-idle-001",
				agent: "pi",
				cwd: "/tmp/project",
				idleMs: 120000,
			};

			await manager.onSessionIdle(staleSession);

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"session_idle",
				expect.objectContaining({
					event: "session_idle",
					session: expect.objectContaining({ id: "sess-idle-001" }),
				}),
			);
		});
	});

	describe("subagent lifecycle", () => {
		it("per-turn adapter result fires subagent_stop event", async () => {
			const adapterResult = {
				sessionId: "sess-004",
				agentName: "coder",
				stopReason: "end_turn",
			};

			await manager.onSubagentStop(adapterResult);

			expect(hookDispatcher.fire).toHaveBeenCalledWith(
				"subagent_stop",
				expect.objectContaining({
					event: "subagent_stop",
					session: expect.objectContaining({ id: "sess-004" }),
					agent: expect.objectContaining({ name: "coder" }),
				}),
			);
		});
	});

	describe("event context shape", () => {
		it("all events include correlationId", async () => {
			await manager.onSessionAdded({
				id: "sess-ctx-001",
				agent: "pi",
				cwd: "/tmp",
			});

			const call = hookDispatcher.fire.mock.calls[0];
			const ctx = call[1] as HookContext;
			expect(ctx.correlationId).toBeDefined();
			expect(typeof ctx.correlationId).toBe("string");
			expect(ctx.correlationId.length).toBeGreaterThan(0);
		});

		it("all events include version: 1 and source: acp", async () => {
			await manager.onSessionAdded({
				id: "sess-ctx-002",
				agent: "pi",
				cwd: "/tmp",
			});

			const call = hookDispatcher.fire.mock.calls[0];
			const ctx = call[1] as HookContext;
			expect(ctx.version).toBe(1);
			expect(ctx.source).toBe("acp");
		});

		it("all events include ISO 8601 timestamp", async () => {
			await manager.onSessionAdded({
				id: "sess-ctx-003",
				agent: "pi",
				cwd: "/tmp",
			});

			const call = hookDispatcher.fire.mock.calls[0];
			const ctx = call[1] as HookContext;
			expect(ctx.timestamp).toBeDefined();
			// ISO 8601 check
			expect(new Date(ctx.timestamp).toISOString()).toBe(ctx.timestamp);
		});
	});

	describe("dispose", () => {
		it("dispose unregisters all listeners", async () => {
			manager.dispose();

			// After dispose, lifecycle callbacks should not fire hooks
			await manager.onSessionAdded({
				id: "sess-after-dispose",
				agent: "pi",
				cwd: "/tmp",
			});

			expect(hookDispatcher.fire).not.toHaveBeenCalled();
		});
	});
});

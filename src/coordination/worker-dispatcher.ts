/**
 * pi-acp-agents — Worker Dispatcher (M6: Auto-Claim Dispatch)
 *
 * Background auto-claim loop that dispatches tasks to idle workers.
 * Uses round-robin/FIFO selection when multiple idle workers compete for tasks.
 * Respects SessionManager busy mutex — skips workers that are already busy.
 */
import type { AcpWorkerRecord } from "../config/types.js";

export interface WorkerDispatcherDeps {
	workerStore: {
		list(options?: { status?: string }): AcpWorkerRecord[];
		updateStatus(name: string, status: "idle" | "busy" | "online" | "offline"): AcpWorkerRecord;
		assignTask(name: string, taskId: string): void;
		unassignTask(name: string): AcpWorkerRecord;
		get(name: string): AcpWorkerRecord | undefined;
		updateMetadata(name: string, metadata: Partial<Record<string, unknown>>): AcpWorkerRecord | undefined;
	};
	taskStore: {
		claimNextAvailable(): Promise<{ id: string; subject: string; description: string | null } | null>;
		update(id: string, mut: (task: { status: string; result: string | null }) => void): Promise<any>;
	};
	eventLog: {
		append(event: string, data: Record<string, unknown>): void;
	};
	busySessions: Map<string, boolean>;
	dispatchTask: (sessionId: string, prompt: string) => Promise<{ ok: boolean; value?: any; error?: string }>;
	getSessionIdForWorker: (workerName: string) => string | undefined;
}

export class WorkerDispatcher {
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private dispatchIndex = 0; // Round-robin index for FIFO worker selection
	private running = false;

	constructor(
		private deps: WorkerDispatcherDeps,
		private intervalMs: number = 5000,
	) {}

	/** Start the auto-claim dispatch loop */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.intervalId = setInterval(() => {
			this.dispatchOnce().catch((err) => {
				this.deps.eventLog.append("dispatch_error", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, this.intervalMs);
	}

	/** Stop the auto-claim dispatch loop */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.running = false;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/**
	 * Single dispatch cycle: iterate idle workers in round-robin order,
	 * attempt to claim a task for each, and dispatch.
	 */
	async dispatchOnce(): Promise<void> {
		const idleWorkers = this.deps.workerStore.list({ status: "idle" });
		if (idleWorkers.length === 0) return;

		// Round-robin: start from dispatchIndex, wrap around
		for (let i = 0; i < idleWorkers.length; i++) {
			const workerIdx = (this.dispatchIndex + i) % idleWorkers.length;
			const worker = idleWorkers[workerIdx]!;

			// Respect busy mutex — skip if session is in-flight
			const sessionId = this.deps.getSessionIdForWorker(worker.name);
			if (sessionId && this.deps.busySessions.get(sessionId)) {
				continue;
			}

			// Try to claim a task
			const task = await this.deps.taskStore.claimNextAvailable();
			if (!task) continue;

			// Build task prompt, prepending any queued steer message
			let prompt = this.buildTaskPrompt(task);
			const workerRecord = this.deps.workerStore.get(worker.name);
			if (workerRecord?.metadata?.pendingSteer) {
				prompt = String(workerRecord.metadata.pendingSteer) + "\n\n" + prompt;
				this.deps.workerStore.updateMetadata(worker.name, { pendingSteer: undefined });
			}

			// Mark worker busy and assign task
			this.deps.workerStore.updateStatus(worker.name, "busy");
			this.deps.workerStore.assignTask(worker.name, task.id);

			// Emit task_assigned event
			this.deps.eventLog.append("task_assigned", {
				workerName: worker.name,
				taskId: task.id,
				sessionId,
			});

			// Advance dispatch index (next worker gets priority)
			this.dispatchIndex = workerIdx + 1;

			// Dispatch and handle completion
			if (sessionId) {
				// Fire-and-forget: dispatch the task, handle completion asynchronously
				this.handleDispatchResult(worker.name, sessionId, task.id, this.deps.dispatchTask(sessionId, prompt));
			}

			// Only dispatch one task per cycle to avoid overwhelming
			return;
		}
	}

	private buildTaskPrompt(task: { id: string; subject: string; description: string | null }): string {
		let prompt = `## Task: ${task.subject}\nTask ID: ${task.id}\n`;
		if (task.description) {
			prompt += `\n${task.description}\n`;
		}
		prompt += `\nComplete this task. Report the result when done.`;
		return prompt;
	}

	private async handleDispatchResult(
		workerName: string,
		sessionId: string,
		taskId: string,
		resultPromise: Promise<{ ok: boolean; value?: any; error?: string }>,
	): Promise<void> {
		try {
			const result = await resultPromise;

			if (result.ok) {
				// Mark task completed
				await this.deps.taskStore.update(taskId, (task) => {
					task.status = "completed";
					task.result = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
				});

				// Emit task_completed event
				this.deps.eventLog.append("task_completed", {
					workerName,
					taskId,
					sessionId,
				});
			} else {
				// Task failed — set back to pending
				await this.deps.taskStore.update(taskId, (task) => {
					task.status = "pending";
					task.result = null;
				});

				this.deps.eventLog.append("task_dispatch_failed", {
					workerName,
					taskId,
					sessionId,
					error: result.error,
				});
			}
		} catch (err) {
			// Unexpected error — set task back to pending
			try {
				await this.deps.taskStore.update(taskId, (task) => {
					task.status = "pending";
					task.result = null;
				});
			} catch {
				// Ignore update errors
			}

			this.deps.eventLog.append("task_dispatch_error", {
				workerName,
				taskId,
				sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			// Always return worker to idle and unassign task
			this.deps.workerStore.updateStatus(workerName, "idle");
			this.deps.workerStore.unassignTask(workerName);
		}
	}
}

/**
 * HookTriggerManager — wraps SessionManager / WorkerDispatcher /
 * HealthMonitor / subagent lifecycle callbacks and dispatches hook events
 * at the correct lifecycle points.
 *
 * Each callback builds a HookContext (via buildHookContext) and forwards it
 * to the hook dispatcher's `fire(event, context)` entry point.
 *
 * Source of truth: flow/plans/acp-hooks-impl-spec.md (Wiring section).
 */
import { buildHookContext } from "./hook-context.js";
import type {
	HookContext,
	HookEventName,
} from "./types.js";

/** Minimal dispatcher interface the trigger manager depends on. */
export interface TriggerHookDispatcher {
	fire(
		event: HookEventName,
		context: HookContext,
	): Promise<unknown> | unknown;
}

/** Minimal session-like shape passed to session callbacks. */
export interface SessionLike {
	id: string;
	agent: string;
	cwd: string;
	idleMs?: number;
}

/** Minimal task-like shape passed to task dispatch callbacks. */
export interface TaskLike {
	id: string;
	subject: string;
	status: string;
	owner?: string;
}

/** Result of a worker dispatch (success or failure). */
export interface TaskResultLike {
	taskId: string;
	subject?: string;
	success: boolean;
	durationMs?: number;
	error?: string;
	result?: string;
	owner?: string;
}

/** Per-turn adapter result that triggers subagent_stop. */
export interface SubagentStopLike {
	sessionId: string;
	agentName: string;
	stopReason?: string;
	cwd?: string;
}

/** Options for removing a session (error path). */
export interface SessionRemoveOptions {
	error?: boolean;
	errorMessage?: string;
}

/** Constructor deps (all the lifecycle sources + the dispatcher). */
export interface HookTriggerManagerOptions {
	sessionManager?: unknown;
	workerDispatcher?: unknown;
	healthMonitor?: unknown;
	hookDispatcher: TriggerHookDispatcher;
	/** Optional default agent type label; defaults to "acp". */
	defaultAgentType?: string;
	/** Optional fallback cwd when a callback doesn't supply one. */
	defaultCwd?: string;
}

const DEFAULT_AGENT_TYPE = "acp";

function safeFire(
	dispatcher: TriggerHookDispatcher,
	event: HookEventName,
	context: HookContext,
): Promise<void> {
	return Promise.resolve(dispatcher.fire(event, context)).then(
		() => undefined,
		() => undefined,
	);
}

/**
 * Wraps lifecycle callbacks and translates them into hook dispatches.
 */
export class HookTriggerManager {
	private readonly dispatcher: TriggerHookDispatcher;
	private readonly defaultAgentType: string;
	private readonly defaultCwd: string;
	private disposed = false;

	// Stored for future wiring / introspection.
	readonly sessionManager?: unknown;
	readonly workerDispatcher?: unknown;
	readonly healthMonitor?: unknown;

	constructor(opts: HookTriggerManagerOptions) {
		this.dispatcher = opts.hookDispatcher;
		this.sessionManager = opts.sessionManager;
		this.workerDispatcher = opts.workerDispatcher;
		this.healthMonitor = opts.healthMonitor;
		this.defaultAgentType = opts.defaultAgentType ?? DEFAULT_AGENT_TYPE;
		this.defaultCwd = opts.defaultCwd ?? "";
	}

	// ── Session lifecycle ──

	/** SessionManager.add() → dispatch `session_started`. */
	onSessionAdded(session: SessionLike): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return safeFire(
			this.dispatcher,
			"session_started",
			buildHookContext({
				event: "session_started",
				session: {
					id: session.id,
					agent: session.agent,
					cwd: session.cwd,
				},
				agent: { name: session.agent, type: this.defaultAgentType },
			}),
		);
	}

	/** SessionManager.remove() → dispatch `session_completed` or `session_failed`. */
	onSessionRemoved(
		session: SessionLike,
		opts?: SessionRemoveOptions,
	): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const failed = opts?.error === true;
		const event: HookEventName = failed ? "session_failed" : "session_completed";
		return safeFire(
			this.dispatcher,
			event,
			buildHookContext({
				event,
				session: {
					id: session.id,
					agent: session.agent,
					cwd: session.cwd,
				},
				agent: { name: session.agent, type: this.defaultAgentType },
			}),
		);
	}

	// ── Task lifecycle ──

	/** WorkerDispatcher.dispatchOnce() → dispatch `task_assigned`. */
	onTaskDispatched(task: TaskLike): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return safeFire(
			this.dispatcher,
			"task_assigned",
			buildHookContext({
				event: "task_assigned",
				session: {
					id: "",
					agent: task.owner ?? this.defaultAgentType,
					cwd: this.defaultCwd,
				},
				agent: {
					name: task.owner ?? this.defaultAgentType,
					type: this.defaultAgentType,
				},
				task: {
					id: task.id,
					subject: task.subject,
					status: task.status,
				},
			}),
		);
	}

	/** WorkerDispatcher.handleDispatchResult() → dispatch `task_completed` or `task_failed`. */
	onTaskResult(result: TaskResultLike): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const event: HookEventName = result.success
			? "task_completed"
			: "task_failed";
		const status = result.success ? "completed" : "failed";
		return safeFire(
			this.dispatcher,
			event,
			buildHookContext({
				event,
				session: {
					id: "",
					agent: result.owner ?? this.defaultAgentType,
					cwd: this.defaultCwd,
				},
				agent: {
					name: result.owner ?? this.defaultAgentType,
					type: this.defaultAgentType,
				},
				task: {
					id: result.taskId,
					subject: result.subject ?? "",
					status,
					durationMs: result.durationMs,
					result: result.error ?? result.result,
				},
			}),
		);
	}

	// ── Health monitor ──

	/** HealthMonitor stale session → dispatch `session_idle`. */
	onSessionIdle(session: SessionLike): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return safeFire(
			this.dispatcher,
			"session_idle",
			buildHookContext({
				event: "session_idle",
				session: {
					id: session.id,
					agent: session.agent,
					cwd: session.cwd,
				},
				agent: { name: session.agent, type: this.defaultAgentType },
			}),
		);
	}

	// ── Subagent lifecycle ──

	/** Per-turn adapter result → dispatch `subagent_stop`. */
	onSubagentStop(result: SubagentStopLike): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return safeFire(
			this.dispatcher,
			"subagent_stop",
			buildHookContext({
				event: "subagent_stop",
				session: {
					id: result.sessionId,
					agent: result.agentName,
					cwd: result.cwd ?? this.defaultCwd,
				},
				agent: {
					name: result.agentName,
					type: this.defaultAgentType,
				},
			}),
		);
	}

	/** Stop firing hooks. After dispose, all callbacks become no-ops. */
	dispose(): void {
		this.disposed = true;
	}
}

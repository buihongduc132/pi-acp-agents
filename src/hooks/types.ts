/**
 * ACP Hooks — canonical types and constants.
 *
 * Source of truth: flow/plans/acp-hooks-impl-spec.md
 *
 * All 10 events (LD8 + spawn_completed): session_started, session_completed,
 * session_failed, session_idle, subagent_start, subagent_stop,
 * task_assigned, task_completed, task_failed, spawn_completed.
 *
 * spawn_completed (OT4): fires ONCE when a long-lived async-spawned session
 * finishes its background prompt. Distinct from subagent_stop (which fires
 * EVERY turn) to avoid flooding the main session under per-turn completion.
 */

/** The 10 hook events ACP implements (LD8 + spawn_completed for async). */
export type HookEventName =
	| "session_started"
	| "session_completed"
	| "session_failed"
	| "session_idle"
	| "subagent_start"
	| "subagent_stop"
	| "task_assigned"
	| "task_completed"
	| "task_failed"
	| "spawn_completed";

/** Failure actions applied by the policy engine (policy.ts). */
export type FailureAction =
	| "warn"
	| "followup"
	| "reopen"
	| "reopen_followup";

/** Allowed followup task owner roles. */
export type FollowupOwner = "member" | "lead" | "none";

/** Per-event hook override. */
export interface HookEventConfig {
	enabled: boolean;
	timeoutMs: number;
}

/**
 * Teams-compat superset signature (LD1, LD17).
 * `task`/`team` are optional and omitted when not provided.
 */
export interface HookContext {
	version: 1;
	event: HookEventName;
	source: "acp";
	/** LD17 — advisory dedup key (UUID v4). */
	correlationId: string;
	session: { id: string; agent: string; cwd: string };
	agent: { name: string; type: string };
	task?: {
		id: string;
		subject: string;
		status: string;
		result?: string;
		durationMs?: number;
	};
	team?: { id: string; leadName: string };
	/** ISO 8601 timestamp. */
	timestamp: string;
}

/** Pre-hook result (LD13 — per-target suppress or blockAll). */
export interface PreHookResult {
	suppress?: Array<"file" | "socket" | "ext">;
	blockAll?: boolean;
	reason?: string;
}

/** Per-hook + global config (LD3 — per-hook enable/disable). */
export interface HookConfig {
	version: 1;
	enabled: boolean;
	hooks: Partial<Record<HookEventName, HookEventConfig>>;
	failureAction: FailureAction;
	followupOwner: FollowupOwner;
	maxReopensPerTask: number;
	socket: {
		enabled: boolean;
		path: string;
		maxMessageSize: number;
		broadcastTimeoutMs: number;
	};
}

/** Socket bus wire format (LD4 — unified socket with event-type field). */
export interface SocketEvent {
	"event-type": string;
	"event-id": string;
	timestamp: string;
	source: string;
	payload: HookContext;
}

/**
 * Default config (LD3). Per-hook entries are not pre-populated — omitted
 * events inherit the global `enabled` flag.
 */
export const DEFAULT_HOOK_CONFIG: HookConfig = {
	version: 1,
	enabled: true,
	hooks: {},
	failureAction: "warn",
	followupOwner: "lead",
	maxReopensPerTask: 3,
	socket: {
		enabled: true,
		path: defaultSocketPath(),
		maxMessageSize: 1_048_576,
		broadcastTimeoutMs: 1000,
	},
};

/** Event types that must NEVER be dropped on backpressure (SG3).
 *  spawn_completed added for async spawn callback delivery (OT4). */
export const NEVER_DROP_EVENT_TYPES: ReadonlySet<string> = new Set([
	"acp.task_completed",
	"acp.session_completed",
	"acp.session_failed",
	"acp.task_failed",
	"acp.spawn_completed",
]);

/** Helper: default socket path under the ACP hooks dir. */
function defaultSocketPath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
	return `${home}/.pi/agent/events.sock`;
}

/** Helper: default hooks config dir. */
export function defaultHooksDir(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
	return `${home}/.pi/agent/acp/hooks`;
}

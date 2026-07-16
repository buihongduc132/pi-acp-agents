/**
 * pi-acp-agents — Shared types
 *
 * Config shape mirrors Zed's `agent_servers` pattern:
 * flat map of name → server config. No provider-specific fields.
 * All customization goes through args/env.
 */

/** Configuration for a single agent alias with fallback chain */
export interface AcpAliasConfig {
	agents: string[];
	strategy: "failover" | "race";
}

/** Per-agent server configuration (matches Zed's agent_servers entry) */
export interface AcpAgentConfig {
	/** How to connect to this agent: 'direct' (subprocess) or 'acpx' (CLI delegation). Default: 'direct'. */
	mode?: "direct" | "acpx";
	/** Required for 'direct' mode. Command to spawn the agent subprocess. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** Default model for sessions created with this agent */
	default_model?: string;
	/** Default mode for sessions created with this agent */
	default_mode?: string;
	/** Persona / system prompt (resolved at spawn time by content shape —
	 * see src/tui/persona-resolver.ts). Soft-fail: never throws. */
	systemPrompt?: string;
	/** Human-readable summary of this agent profile (persona + prompt + goal); the underlying server = transport: command/args/env/cwd. Multiple profiles may share one server. */
	description?: string;
	/** Allow passthrough of unknown fields for forward compat */
	[key: string]: unknown;
}

/** Top-level config stored at ~/.pi/acp-agents/config.json */
export interface AcpConfig {
	/** Agent server definitions. Key = alias name. Matches Zed's agent_servers. */
	agent_servers: Record<string, AcpAgentConfig>;
	defaultAgent?: string;
	logsDir?: string;
	staleTimeoutMs?: number;
	healthCheckIntervalMs?: number;
	/** Shorter, dedicated TTL (ms) for completed (non-busy) idle sessions. Defaults to staleTimeoutMs (1h) when unset. */
	completedIdleTtlMs?: number;
	circuitBreakerMaxFailures?: number;
	circuitBreakerResetMs?: number;
	/** Stall timeout in milliseconds (default: 3_600_000 = 1 hour) */
	stallTimeoutMs?: number;
	/** Per-tool timeout overrides in milliseconds. Falls back to stallTimeoutMs. */
	toolTimeouts?: {
		prompt?: number;
		delegate?: number;
		broadcast?: number;
		compare?: number;
	};
	/** Worker lifecycle config */
	workerAutoClaim?: boolean;           // default: true
	workerClaimIntervalMs?: number;      // default: 5000
	workerShutdownTimeoutMs?: number;     // default: 30000
	workerOnlineMs?: number;              // default: 60000
	workerStaleMs?: number;               // default: 60000
	/** Activity-based stall detection for persistent sessions (ms) */
	needsAttentionMs?: number;     // default: 60_000
	autoInterruptMs?: number;      // default: 300_000, 0 = disabled
	interruptGraceMs?: number;     // default: 10_000
	/** Agent alias definitions for fallback chains */
	agent_aliases?: Record<string, AcpAliasConfig>;
	/** Timeout for race strategy in ms (default: 30_000 = 30s) */
	raceTimeoutMs?: number;
	/** DAG stale timeout in ms — a DAG with no step transitions for this long is marked `stale` (default: 3_600_000 = 1 hour). */
	dagStaleTimeoutMs?: number;
	/** Maximum chars of a step output injected into downstream prompts before truncation (default: 8000). */
	dagOutputTruncateChars?: number;
	runtimeDir?: string;
	modelPolicy?: {
		allowedModels?: string[];
		blockedModels?: string[];
		requireProviderPrefix?: boolean;
	};
	/** Spawn (acp_spawn) behavior options.
	 *
	 * asyncDefault controls the async-by-default behavior introduced for
	 * spawn-with-prompt (LD2/OT4). This is a GLOBAL opt-out for callers that
	 * need the legacy inline-response contract from `acp_spawn`. Default: true
	 * (the new async behavior). Per-call `async` parameter still overrides. */
	spawns?: {
		/** When true (default), spawn-with-prompt returns immediately with
		 *  status:'prompting' and runs the prompt in the background. Set false
		 *  to restore the legacy blocking behavior globally. Per-call `async`
		 *  param overrides this default. */
		asyncDefault?: boolean;
		/** Bounded timeout (ms) the shutdown handler waits for in-flight
		 *  async-spawn background prompts to resolve before persisting their
		 *  terminal state. Prevents shutdown hang while avoiding silent data
		 *  loss. Default: 10_000 (10s). 0 = persist immediately without
		 *  waiting. */
		asyncShutdownDrainMs?: number;
	};
}

/**
 * Back-compat: old configs may use `agents` instead of `agent_servers`.
 * This legacy type is only used during migration.
 */
export interface LegacyAcpConfig {
	agents?: Record<string, AcpAgentConfig>;
	agent_servers?: Record<string, AcpAgentConfig>;
	[key: string]: unknown;
}

/** Alias used by some tests */
export type AcpAgentsConfig = AcpConfig;

/** Result of a prompt call */
export interface AcpPromptResult {
	text: string;
	stopReason: string;
	sessionId: string;
	stalled?: boolean;
}

/** Tracked session info */
export interface AcpSessionInfo {
	sessionId: string;
	sessionName?: string;
	agentName: string;
	cwd: string;
	model?: string;
	mode?: string;
	createdAt: Date;
}

/** Archived runtime metadata used to reopen ACP sessions after auto-close. */
export interface AcpArchivedSessionMetadata {
	sessionId: string;
	sessionName?: string;
	agentName: string;
	cwd: string;
	createdAt: Date;
	lastActivityAt: Date;
	lastResponseAt?: Date;
	completedAt?: Date;
	disposed: boolean;
	autoClosed?: boolean;
	closeReason?: string;
	model?: string;
	mode?: string;
	/** Loadability tracking — whether this archived session can be successfully resumed */
	loadStatus?: "loadable" | "unloadable" | "unknown";
	lastLoadAttemptAt?: string;
	lastLoadError?: string;
	loadAttemptCount?: number;
}

/** Internal handle kept by SessionManager. Also satisfies HealthMonitorable. */
export interface AcpSessionHandle extends AcpArchivedSessionMetadata {
	accumulatedText: string;
	busy?: boolean;
	/** True while a prompt() call is in-flight */
	isPrompting?: boolean;
	/** Timestamp when the current prompt started */
	promptStartedAt?: Date;
	planStatus?: "none" | "pending" | "approved" | "rejected";
	dispose: () => Promise<void>;
}

/** Circuit breaker states */
export type CircuitState = "closed" | "open" | "half-open";

/** Adapter options */
export interface AcpAdapterOptions {
	config: AcpAgentConfig;
	clientInfo?: { name: string; version: string };
	logger?: Logger;
	cwd?: string;
	agentName?: string;
	/** Activity callback — called on every session/update notification from the agent */
	onActivity?: (sessionId: string) => void;
	/** Session update callback — called on every session/update with full update data */
	onSessionUpdate?: (sessionId: string, update: import("@agentclientprotocol/sdk").SessionUpdate) => void;
}

// --- Worker types (M6) ---

export type AcpWorkerStatus = "online" | "idle" | "busy" | "streaming" | "offline";

export interface AcpWorkerRecord {
	name: string;
	sessionId: string;
	agentName: string;
	status: AcpWorkerStatus;
	currentTaskId?: string;
	spawnedAt: string;
	lastActivityAt: string;
	/** Last heartbeat timestamp (ISO 8601), updated on every session/update event */
	lastHeartbeatAt?: string;
	/** Cumulative token count (tokensIn + tokensOut) from session/update deltas */
	tokenCountTotal?: number;
	/** Count of tool calls observed from session/update events */
	toolCallCount?: number;
	metadata: Record<string, unknown>;
}

// --- Child usage sink (P2 — cross-plugin shared schema) ---
// Canonical contract:
//   flow/findings/2026-07-17-unify-child-usage/solutions/child-usage-schema-contract.md
// Both pi-acp-agents and pi-agent-teams MUST write to the SAME path/shape.
export type ChildUsageSource = "acp" | "teams";

/**
 * Single JSON object written to ~/.pi/agent/child-usage/<childSessionId>.json
 * so external apps can read child-agent token/duration data from ONE place.
 */
export interface ChildUsageRecord {
	/** Schema bump on breaking change. Currently 1. */
	schemaVersion: 1;
	/** Stable per-spawn session id (matches filename). REQUIRED. */
	childSessionId: string;
	/** Leader/pi session that owns this child. null if unknown. */
	parentSessionId: string | null;
	/** Which plugin wrote this record. */
	source: ChildUsageSource;
	/** Cumulative in+out tokens (ABSOLUTE total, not delta). */
	tokensTotal: number;
	/** Count of tool_execution_end observed. */
	toolCalls: number;
	/** Count of agent_end / turn boundaries. ACP has no per-turn events → 0. */
	turns: number;
	/** endedAt - startedAt (wall clock), ms. 0 while running. */
	durationMs: number;
	/** Hedge field — currently always "wallclock". */
	durationScope: "wallclock";
	/** ISO 8601 UTC — first spawn/heartbeat time. */
	startedAt: string;
	/** ISO 8601 UTC — touched on every write. */
	updatedAt: string;
	/** Set on terminal exit/cleanup. null while running. */
	endedAt: string | null;
}

// --- Task priority (M3, M5) ---

export type AcpTaskPriority = "urgent" | "high" | "normal" | "low";

// --- Async run types (M1) ---

export type AcpAsyncRunState = "pending" | "running" | "completed" | "failed";

export interface AcpAsyncRunRecord {
	runId: string;
	agentName: string;
	message: string;
	cwd?: string;
	state: AcpAsyncRunState;
	sessionId?: string;
	result?: string;
	error?: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
}

/** Logger interface */
export interface Logger {
	info(msg: string, data?: unknown): void;
	warn(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
	debug(msg: string, data?: unknown): void;
}

// --- DAG delegation types (acp-dag-delegation) ---

/**
 * A single declarative task within a submitted DAG.
 *
 * Mirrors the `acp_dag_submit` task shape from design.md (D8).
 */
export interface DagTaskDefinition {
	/** Unique step identifier (must not be a reserved word: dag, step, agent). */
	id: string;
	/** Agent name; must exist in `agent_servers` config. */
	agent: string;
	/** Prompt text; may contain `{<id>.output}`, `{<id>.status}`, `{dag.args.<key>}` template vars. */
	prompt: string;
	/** Step IDs this step depends on. Default: []. */
	dependsOn?: string[];
	/** Gate type applied to ALL dependencies. Default: "needs". */
	gate?: "needs" | "after";
}

/** Lifecycle status for a DAG step. */
export type DagStepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped"
	| "cancelled";

/** Lifecycle status for a DAG as a whole. */
export type DagStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "stale";

/** Runtime execution state for a single DAG step. */
export interface DagStepRecord {
	id: string;
	agent: string;
	prompt: string;
	dependsOn: string[];
	gate: "needs" | "after";
	status: DagStepStatus;
	/** Text result on success; null/undefined otherwise. */
	output?: string | null;
	/** Error message on failure. */
	error?: string;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	/** Number of retries already attempted for this step. */
	retryCount?: number;
}

/** DAG-level submission options. */
export interface DagOptions {
	/** Default: true. */
	failFast?: boolean;
	/** Default: 0. */
	maxRetries?: number;
}

/** Full file-backed DAG record persisted to `~/.pi/acp-agents/dag/<dagId>.json`. */
export interface DagRecord {
	dagId: string;
	tasks: DagTaskDefinition[];
	args?: Record<string, string>;
	options?: DagOptions;
	status: DagStatus;
	steps: Record<string, DagStepRecord>;
	currentWave: number;
	totalWaves: number;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

/** Summary entry stored in `~/.pi/acp-agents/dag/dag-index.json`. */
export interface DagIndexEntry {
	dagId: string;
	status: DagStatus;
	totalSteps: number;
	completedSteps: number;
	failedSteps: number;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

/**
 * pi-acp-types — Shared type definitions for pi-acp-agents ecosystem.
 *
 * Used by both the base package (pi-acp-agents) and the extension
 * package (pi-acp-advanced). Breaking changes here require a major version bump.
 *
 * @packageDocumentation
 */

// ── Config types ────────────────────────────────────────────────────────────

/** Per-agent server configuration (matches Zed's agent_servers entry) */
export interface AcpAgentConfig {
	/** How the agent is invoked: 'direct' (subprocess) or 'acpx' (CLI delegation). Defaults to 'direct'. */
	mode?: "direct" | "acpx";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** Default model for sessions created with this agent */
	default_model?: string;
	/** Default mode for sessions created with this agent */
	default_mode?: string;
	/** Persona / system prompt. Resolved by content shape at spawn time:
	 * - contains whitespace → inline (the string IS the persona)
	 * - starts with `http` → gist URL (**DEFERRED** — not yet implemented; soft-fails)
	 * - otherwise → file path (readFileSync)
	 *
	 * Resolution failures soft-fail (callout to user, never throw). The resolved
	 * persona is prepended to the first user message of a fresh session. NOTE:
	 * ACP has no native system-prompt field, so this is a first-turn prefix
	 * (practical high priority, not protocol-level). See
	 * `flow/plans/acp-persona-system-prompt.md`.
	 */
	systemPrompt?: string;
	/** Stall timeout in milliseconds for acpx mode */
	stallTimeoutMs?: number;
	/** Agent name for acpx session creation (defaults to adapter name) */
	agentName?: string;
	/** Allow passthrough of unknown fields for forward compat */
	[key: string]: unknown;
}

/** Configuration for a single alias with fallback chain */
export interface AcpAliasConfig {
	agents: string[];
	strategy: "failover" | "race";
}

/** Top-level ACP config stored at ~/.pi/acp-agents/config.json */
export interface AcpConfig {
	/** Agent server definitions. Key = name. Matches Zed's agent_servers. */
	agent_servers: Record<string, AcpAgentConfig>;
	defaultAgent?: string;
	logsDir?: string;
	staleTimeoutMs?: number;
	healthCheckIntervalMs?: number;
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
	/** Activity-based stall detection for persistent sessions (ms) */
	needsAttentionMs?: number;
	autoInterruptMs?: number;
	interruptGraceMs?: number;
	/** Agent alias definitions for fallback chains */
	agent_aliases?: Record<string, AcpAliasConfig>;
	/** Timeout in milliseconds for race strategy (default: 30_000) */
	raceTimeoutMs?: number;
	runtimeDir?: string;
	modelPolicy?: {
		allowedModels?: string[];
		blockedModels?: string[];
		requireProviderPrefix?: boolean;
	};
}

// ── Result types ────────────────────────────────────────────────────────────

/** Result of a prompt call */
export interface AcpPromptResult {
	text: string;
	stopReason: string;
	sessionId: string;
	stalled?: boolean;
}

// ── Session types ───────────────────────────────────────────────────────────

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

// ── Adapter types ───────────────────────────────────────────────────────────

/** Logger interface */
export interface Logger {
	info(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
	debug(msg: string, data?: unknown): void;
}

/** Adapter options passed to adapter constructors */
export interface AcpAdapterOptions {
	config: AcpAgentConfig;
	clientInfo?: { name: string; version: string };
	logger?: Logger;
	cwd?: string;
	agentName?: string;
	/** Activity callback — called on every session/update notification */
	onActivity?: (sessionId: string) => void;
}

// ── Worker types ────────────────────────────────────────────────────────────

export type AcpWorkerStatus = "online" | "idle" | "streaming" | "offline";

export interface AcpWorkerRecord {
	name: string;
	sessionId: string;
	agentName: string;
	status: AcpWorkerStatus;
	currentTaskId?: string;
	spawnedAt: string;
	lastActivityAt: string;
	metadata: Record<string, unknown>;
}

// ── Task priority ───────────────────────────────────────────────────────────

export type AcpTaskPriority = "urgent" | "high" | "normal" | "low";

// ── Async run types ─────────────────────────────────────────────────────────

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

// ── Circuit breaker types ───────────────────────────────────────────────────

/** Circuit breaker states */
export type CircuitState = "closed" | "open" | "half-open";

// ── Runtime paths ───────────────────────────────────────────────────────────

/** Resolved runtime file paths for ACP state storage */
export interface AcpRuntimePaths {
	rootDir: string;
	tasksFile: string;
	mailboxesFile: string;
	governanceFile: string;
	eventLogFile: string;
	sessionArchiveFile: string;
	sessionNameRegistryFile: string;
	workersFile: string;
}

// ── Legacy config (migration only) ─────────────────────────────────────────

/** Back-compat: old configs may use `agents` instead of `agent_servers`. */
export interface LegacyAcpConfig {
	agents?: Record<string, AcpAgentConfig>;
	agent_servers?: Record<string, AcpAgentConfig>;
	[key: string]: unknown;
}

/** Alias used by some tests and internal code */
export type AcpAgentsConfig = AcpConfig;

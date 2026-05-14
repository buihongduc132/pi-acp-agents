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
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** Default model for sessions created with this agent */
	default_model?: string;
	/** Default mode for sessions created with this agent */
	default_mode?: string;
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
	needsAttentionMs?: number;     // default: 60_000
	autoInterruptMs?: number;      // default: 300_000, 0 = disabled
	interruptGraceMs?: number;     // default: 10_000
	/** Agent alias definitions for fallback chains */
	agent_aliases?: Record<string, AcpAliasConfig>;
	runtimeDir?: string;
	modelPolicy?: {
		allowedModels?: string[];
		blockedModels?: string[];
		requireProviderPrefix?: boolean;
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
}

/** Logger interface */
export interface Logger {
	info(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
	debug(msg: string, data?: unknown): void;
}

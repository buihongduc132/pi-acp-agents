/**
 * pi-acp-agents — Shared types
 */

/** Per-agent configuration */
export interface AcpAgentConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	defaultModel?: string;
	/** Level 2: Thinking level to set after session creation */
	thinkingLevel?: string;
	/** Level 2: Sandbox mode */
	sandbox?: boolean;
	/** Level 2: Skip trust prompt */
	skipTrust?: boolean;
	/** Level 2: MCP servers to pass to newSession */
	mcpServers?: Array<{ name: string; command: string; args?: string[] }>;
	[key: string]: unknown;
}

/** Top-level config stored at ~/.pi/acp-agents/config.json */
export interface AcpConfig {
	agents: Record<string, AcpAgentConfig>;
	defaultAgent?: string;
	logsDir?: string;
	staleTimeoutMs?: number;
	healthCheckIntervalMs?: number;
	circuitBreakerMaxFailures?: number;
	circuitBreakerResetMs?: number;
	/** Stall timeout in ms for prompt operations (default: 5 minutes) */
	stallTimeoutMs?: number;
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
	agentName: string;
	cwd: string;
	model?: string;
	createdAt: Date;
}

/** Internal handle kept by SessionManager. Also satisfies HealthMonitorable. */
export interface AcpSessionHandle {
	sessionId: string;
	agentName: string;
	cwd: string;
	model?: string;
	createdAt: Date;
	lastActivityAt: Date;
	accumulatedText: string;
	disposed: boolean;
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
}

/** Logger interface */
export interface Logger {
	info(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
	debug(msg: string, data?: unknown): void;
}

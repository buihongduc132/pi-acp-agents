/**
 * pi-acp-agents — Shared types
 *
 * Re-exports from pi-acp-types for backward compatibility.
 * New consumers should import directly from "pi-acp-types".
 *
 * Config shape mirrors Zed's `agent_servers` pattern:
 * flat map of name → server config. No provider-specific fields.
 * All customization goes through args/env.
 */

// Re-export all shared types from pi-acp-types for backward compat
export {
	AcpAgentConfig,
	AcpAliasConfig,
	AcpConfig,
	AcpPromptResult,
	AcpSessionInfo,
	AcpArchivedSessionMetadata,
	AcpSessionHandle,
	Logger,
	AcpAdapterOptions,
	AcpWorkerStatus,
	AcpWorkerRecord,
	AcpTaskPriority,
	AcpAsyncRunState,
	AcpAsyncRunRecord,
	CircuitState,
	AcpRuntimePaths,
	LegacyAcpConfig,
	AcpAgentsConfig,
} from "pi-acp-types";

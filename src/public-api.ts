/**
 * pi-acp-agents — Public API surface for extension packages.
 *
 * This is the stable contract that pi-acp-advanced (and other extensions)
 * import from. Breaking changes here require a major version bump.
 *
 * Usage from extension:
 *   import { loadConfig, AcpConfig, getRuntimePaths } from "pi-acp-agents";
 */

// Config
export { loadConfig, validateConfig, saveConfig, resolveConfigPath } from "./config/config.js";

// Runtime
export { ensureRuntimeDir } from "./management/runtime-paths.js";

// Types (re-exported from pi-acp-types)
export type {
	AcpConfig,
	AcpAgentConfig,
	AcpAliasConfig,
	AcpPromptResult,
	AcpSessionHandle,
	AcpArchivedSessionMetadata,
	AcpRuntimePaths,
	AcpAdapterOptions,
	Logger,
	CircuitState,
} from "pi-acp-types";

// Core classes (stable API for extensions)
export { AcpCircuitBreaker } from "./core/circuit-breaker.js";
export { HealthMonitor } from "./core/health-monitor.js";
export { SessionManager } from "./core/session-manager.js";

// Adapter factory (for extension packages to create agent adapters)
export { createAdapter } from "./adapter-factory.js";

// Coordination
export { AgentCoordinator } from "./coordination/coordinator.js";
export { AliasResolver } from "./coordination/alias-resolver.js";

// Logging
export { createFileLogger, createNoopLogger } from "./logger.js";

// Stores (for extension packages to instantiate against shared runtime dir)
export { AcpTaskStore } from "./management/task-store.js";
export { MailboxManager } from "./management/mailbox-manager.js";
export { GovernanceStore } from "./management/governance-store.js";
export { SessionArchiveStore } from "./management/session-archive-store.js";
export { SessionNameStore } from "./management/session-name-store.js";
export { WorkerStore } from "./management/worker-store.js";
export { AcpEventLog } from "./management/event-log.js";

// Version
export { version } from "../package.json" with { type: "json" };

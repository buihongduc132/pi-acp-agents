/**
 * pi-acp-agents — Config loading and validation
 *
 * Config shape mirrors Zed's `agent_servers` pattern.
 * Back-compat: auto-migrates old `agents` key to `agent_servers`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { AcpAgentConfig, AcpAliasConfig, AcpConfig, LegacyAcpConfig } from "./types.js";
import { createNoopLogger } from "../logger.js";

const log = createNoopLogger();

const CONFIG_PATH = join(homedir(), ".pi", "acp-agents", "config.json");

export const DEFAULT_CONFIG: AcpConfig = {
	agent_servers: {},
	staleTimeoutMs: 3_600_000,
	healthCheckIntervalMs: 30_000,
	circuitBreakerMaxFailures: 3,
	circuitBreakerResetMs: 60_000,
	stallTimeoutMs: 3_600_000, // 1 hour default stall timeout
	workerAutoClaim: true,
	workerClaimIntervalMs: 5_000,
	workerShutdownTimeoutMs: 30_000,
	workerOnlineMs: 60_000,
	workerStaleMs: 60_000,
	dagStaleTimeoutMs: 3_600_000, // 1 hour default DAG stale timeout
	dagOutputTruncateChars: 8_000, // default truncation limit for injected step outputs
	modelPolicy: {
		allowedModels: [],
		blockedModels: [],
		requireProviderPrefix: false,
	},
	// CA-3: async-by-default is the new desired behavior (LD2/OT4), but it is a
	// BREAKING change to the acp_spawn contract (callers used to get the inline
	// response via content[0].text; now they get status:'prompting'). This
	// global opt-out lets deployments restore the legacy blocking behavior.
	// Per-call `async:false` still overrides regardless of this setting.
	spawns: {
		asyncDefault: true,
		asyncShutdownDrainMs: 10_000,
	},
};

/** Known agent presets with auto-detected commands */
export const AGENT_PRESETS: Record<string, () => AcpAgentConfig | null> = {
	gemini: () => {
		try {
			execSync("which gemini", { stdio: "pipe" });
			return { command: "gemini", args: ["--acp"] };
		} catch (e) { /* gemini not found on PATH */ log.debug("gemini preset not found", e); return null; }
	},
	opencode: () => {
		for (const cmd of ["opencode", "ocxo"]) {
			try {
				execSync(`which ${cmd}`, { stdio: "pipe" });
				return { command: cmd, args: ["acp"] };
			} catch (e) { /* binary not found on PATH */ log.debug(`opencode preset '${cmd}' not found`, e); continue; }
		}
		return null;
	},
	codex: () => {
		try {
			execSync("which codex-acp", { stdio: "pipe" });
			return { command: "codex-acp", args: [] };
		} catch (e) { /* codex-acp not found on PATH */ log.debug("codex-acp preset not found", e); return null; }
	},
};

export function resolveConfigPath(): string {
	return CONFIG_PATH;
}

/**
 * Migrate old `agents` key to `agent_servers`.
 * Returns normalized partial config with `agent_servers` (never `agents`).
 */
function migrateLegacyConfig(raw: Record<string, unknown>): Partial<AcpConfig> {
	if ("agents" in raw && !("agent_servers" in raw)) {
		raw.agent_servers = raw.agents;
		delete raw.agents;
	}
	return raw as Partial<AcpConfig>;
}

/** Validate a partial config. Throws on invalid. Returns full config with defaults merged. */
export function validateConfig(partial: Partial<AcpConfig>): AcpConfig {
	if (!partial.agent_servers || typeof partial.agent_servers !== "object") {
		throw new Error('Config must have an "agent_servers" object');
	}

	const entries = Object.entries(partial.agent_servers);
	// Allow empty agent_servers (relaxed validation for CRUD operations)
	// Still validate individual entries if present

	const agent_servers: Record<string, AcpAgentConfig> = {};
	for (const [name, agent] of entries) {
		// EC-16: Validate agent name is non-empty
		if (!name || name.trim() === "") {
			throw new Error("Agent name must be a non-empty string");
		}

		if (!agent || typeof agent !== "object") {
			throw new Error(`Invalid agent config for "${name}": must be an object`);
		}
		// description (optional): when present MUST be a string. No length cap.
		if (
			"description" in agent &&
			agent.description !== undefined &&
			typeof agent.description !== "string"
		) {
			throw new Error(
				`description must be a string on agent "${name}"`,
			);
		}
		// Command is required unless mode is 'acpx' (acpx derives command from its own binary)
		const isAcpxMode = (agent as Record<string, unknown>).mode === "acpx";
		if (
			!isAcpxMode &&
			(!("command" in agent) ||
				typeof agent.command !== "string" ||
				!agent.command)
		) {
			throw new Error(
				`Invalid agent config for "${name}": "command" is required (or set mode: "acpx")`,
			);
		}
		agent_servers[name] = {
			...agent,
			args: agent.args ?? [],
			env: agent.env ?? {},
		};
	}

	// Clamp stallTimeoutMs to minimum 60_000 (1 minute)
	const rawStallTimeout = partial.stallTimeoutMs ?? DEFAULT_CONFIG.stallTimeoutMs!;
	const stallTimeoutMs = Math.max(rawStallTimeout, 60_000);

	const resolved: AcpConfig = {
		...DEFAULT_CONFIG,
		...partial,
		agent_servers,
		stallTimeoutMs,
		staleTimeoutMs: partial.staleTimeoutMs ?? DEFAULT_CONFIG.staleTimeoutMs,
		healthCheckIntervalMs:
			partial.healthCheckIntervalMs ?? DEFAULT_CONFIG.healthCheckIntervalMs,
		completedIdleTtlMs:
			partial.completedIdleTtlMs ?? partial.staleTimeoutMs ?? DEFAULT_CONFIG.staleTimeoutMs,
		circuitBreakerMaxFailures:
			partial.circuitBreakerMaxFailures ??
			DEFAULT_CONFIG.circuitBreakerMaxFailures,
		circuitBreakerResetMs:
			partial.circuitBreakerResetMs ?? DEFAULT_CONFIG.circuitBreakerResetMs,
		dagStaleTimeoutMs:
			partial.dagStaleTimeoutMs ?? DEFAULT_CONFIG.dagStaleTimeoutMs,
		dagOutputTruncateChars:
			partial.dagOutputTruncateChars ??
			DEFAULT_CONFIG.dagOutputTruncateChars,
		modelPolicy: {
			...DEFAULT_CONFIG.modelPolicy,
			...partial.modelPolicy,
		},
		toolTimeouts: partial.toolTimeouts
			? { ...partial.toolTimeouts }
			: undefined,
		spawns: {
			asyncDefault:
				partial.spawns?.asyncDefault ?? DEFAULT_CONFIG.spawns!.asyncDefault,
			asyncShutdownDrainMs:
				partial.spawns?.asyncShutdownDrainMs ??
				DEFAULT_CONFIG.spawns!.asyncShutdownDrainMs,
		},
	};

	// EC-20: Validate numeric fields are non-negative
	validateNumericFields(resolved);
	// EC-21: Validate healthCheckIntervalMs <= staleTimeoutMs
	validateTimeoutOrder(resolved);
	// Validate completedIdleTtlMs, when explicitly set, is greater than
	// healthCheckIntervalMs so we never reap a session on the very tick it
	// completed. When unset it falls back to staleTimeoutMs, whose relationship
	// to healthCheckIntervalMs is already covered by validateTimeoutOrder.
	validateCompletedIdleTtl(resolved, partial.completedIdleTtlMs);
	// EC-22: Validate agent_aliases if present
	if (resolved.agent_aliases) {
		validateAgentAliases(resolved.agent_aliases, resolved.agent_servers);
	}

	return resolved;
}

/** Validate numeric timeout fields are non-negative (EC-20) */
function validateNumericFields(resolved: AcpConfig): void {
	const numericFields: Array<[string, number | undefined]> = [
		["staleTimeoutMs", resolved.staleTimeoutMs],
		["healthCheckIntervalMs", resolved.healthCheckIntervalMs],
		["circuitBreakerResetMs", resolved.circuitBreakerResetMs],
		["dagStaleTimeoutMs", resolved.dagStaleTimeoutMs],
		["dagOutputTruncateChars", resolved.dagOutputTruncateChars],
	];
	for (const [field, val] of numericFields) {
		if (val !== undefined && val < 0) {
			throw new Error(`Config field "${field}" must be non-negative`);
		}
	}
	if (
		resolved.circuitBreakerMaxFailures !== undefined &&
		resolved.circuitBreakerMaxFailures < 0
	) {
		throw new Error(
			'Config field "circuitBreakerMaxFailures" must be non-negative',
		);
	}
}

/** Validate healthCheckIntervalMs <= staleTimeoutMs (EC-21) */
function validateTimeoutOrder(resolved: AcpConfig): void {
	if (resolved.healthCheckIntervalMs! > resolved.staleTimeoutMs!) {
		throw new Error("healthCheckIntervalMs must be <= staleTimeoutMs");
	}
}

/** Validate completedIdleTtlMs > healthCheckIntervalMs, when explicitly set.
 *  Only enforced for user-provided values; the auto-fallback to staleTimeoutMs
 *  is governed by validateTimeoutOrder. */
function validateCompletedIdleTtl(resolved: AcpConfig, explicit?: number): void {
	if (explicit === undefined) return;
	const interval = resolved.healthCheckIntervalMs!;
	if (explicit <= interval) {
		throw new Error(
			"completedIdleTtlMs must be greater than healthCheckIntervalMs",
		);
	}
}

/** Validate agent_aliases entries (EC-22) */
function validateAgentAliases(
	aliases: Record<string, AcpAliasConfig>,
	agent_servers: Record<string, AcpAgentConfig>,
): void {
	for (const [aliasName, alias] of Object.entries(aliases)) {
		if (!aliasName || aliasName.trim() === "") {
			throw new Error("Alias name must be a non-empty string");
		}
		if (!alias.agents || !Array.isArray(alias.agents) || alias.agents.length === 0) {
			throw new Error(`Alias "${aliasName}" must have a non-empty agents array`);
		}
		if (alias.strategy !== "failover" && alias.strategy !== "race") {
			throw new Error(`Alias "${aliasName}" strategy must be "failover" or "race", got "${alias.strategy}"`);
		}
		for (const agentName of alias.agents) {
			if (!agent_servers[agentName]) {
				throw new Error(`Alias "${aliasName}" references unknown agent "${agentName}"`);
			}
		}
	}
}

/** Load config from disk, falling back to defaults. Auto-migrates old `agents` key. */
export function loadConfig(configPath?: string): AcpConfig {
	const path = configPath ?? CONFIG_PATH;
	if (!existsSync(path)) {
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const needsMigration = "agents" in raw && !("agent_servers" in raw);
		const migrated = migrateLegacyConfig(raw);

		// Auto-save migrated config back to disk
		if (needsMigration) {
			try {
				writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
			} catch (e) { log.debug("config migration write failed", e); /* best-effort */ }
		}

		return validateConfig(migrated);
	} catch (e) {
		// Config file corrupt or unreadable — fall back to defaults
		log.debug("config load failed, using defaults", e);
		return structuredClone(DEFAULT_CONFIG);
	}
}

/** Save config to disk at the given path (or default path) */
export function saveConfig(config: AcpConfig, configPath?: string): void {
	const path = configPath ?? CONFIG_PATH;
	const dir = dirname(path);
	try {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const data = JSON.stringify(config, null, 2) + "\n";
		writeFileSync(path, data, "utf-8");
	} catch (e) {
		// EACCES or other FS error — silently degrade. Config changes are non-critical.
		log.debug("config save failed", e);
	}
}

/** Add or update an agent server entry. Returns a new config (does not mutate original). */
export function upsertAgentServer(config: AcpConfig, name: string, agent: Partial<AcpAgentConfig> & { command: string }): AcpConfig {
	if (!name || name.trim() === "") {
		throw new Error("Agent name must be a non-empty string");
	}
	if (!agent.command || agent.command.trim() === "") {
		throw new Error('Agent "command" is required');
	}
	const cloned = structuredClone(config);
	// Preserve existing unmanaged fields (systemPrompt, mode, cwd, custom props)
	// by merging with the current entry if it exists — prevents silent data loss
	// of the agent persona when editing a subset of fields via TUI/CLI.
	const existing = cloned.agent_servers[name] ?? {};
	const desc = typeof agent.description === "string" && agent.description.length > 0 ? agent.description : undefined;
	const updated: AcpAgentConfig = {
		...existing,
		command: agent.command,
		args: agent.args ?? existing.args ?? [],
		env: agent.env ?? existing.env ?? {},
	};
	if ("default_model" in agent) {
		if (agent.default_model) updated.default_model = agent.default_model;
		else delete updated.default_model;
	}
	if ("default_mode" in agent) {
		if (agent.default_mode) updated.default_mode = agent.default_mode;
		else delete updated.default_mode;
	}
	if ("description" in agent) {
		if (desc !== undefined) updated.description = desc;
		else delete updated.description;
	}
	cloned.agent_servers[name] = updated;
	return cloned;
}

/** Remove an agent server entry. Returns a new config (does not mutate original). Clears defaultAgent if it was the removed agent. */
export function removeAgentServer(config: AcpConfig, name: string): AcpConfig {
	const cloned = structuredClone(config);
	delete cloned.agent_servers[name];
	if (cloned.defaultAgent === name) {
		delete cloned.defaultAgent;
	}
	return cloned;
}

/** Set the default agent. Returns a new config (does not mutate original). Throws if agent not found. */
export function setDefaultAgent(config: AcpConfig, name: string): AcpConfig {
	if (!config.agent_servers[name]) {
		throw new Error(`Agent "${name}" not found`);
	}
	const cloned = structuredClone(config);
	cloned.defaultAgent = name;
	return cloned;
}

/** Detect available agent presets from the system PATH. */
export function detectAvailablePresets(): Array<{ name: string; config: AcpAgentConfig }> {
	const results: Array<{ name: string; config: AcpAgentConfig }> = [];
	for (const [name, factory] of Object.entries(AGENT_PRESETS)) {
		const config = factory();
		if (config) {
			results.push({ name, config });
		}
	}
	return results;
}

/** Get a specific agent config, throwing if not found */
export function getAgentConfig(
	config: AcpConfig,
	name: string,
): AcpAgentConfig {
	const agent = config.agent_servers[name];
	if (!agent) {
		const available = Object.keys(config.agent_servers).join(", ");
		throw new Error(`Agent "${name}" not found. Available: ${available}`);
	}
	return agent;
}

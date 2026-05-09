/**
 * pi-acp-agents — Config loading and validation
 *
 * Config shape mirrors Zed's `agent_servers` pattern.
 * Back-compat: auto-migrates old `agents` key to `agent_servers`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { AcpAgentConfig, AcpConfig, LegacyAcpConfig } from "./types.js";

const CONFIG_PATH = join(homedir(), ".pi", "acp-agents", "config.json");

export const DEFAULT_CONFIG: AcpConfig = {
	agent_servers: {},
	staleTimeoutMs: 3_600_000,
	healthCheckIntervalMs: 30_000,
	circuitBreakerMaxFailures: 3,
	circuitBreakerResetMs: 60_000,
	stallTimeoutMs: 3_600_000, // 1 hour default stall timeout
	modelPolicy: {
		allowedModels: [],
		blockedModels: [],
		requireProviderPrefix: false,
	},
};

/** Known agent presets with auto-detected commands */
export const AGENT_PRESETS: Record<string, () => AcpAgentConfig | null> = {
	gemini: () => {
		try {
			execSync("which gemini", { stdio: "pipe" });
			return { command: "gemini", args: ["--acp"] };
		} catch { return null; }
	},
	opencode: () => {
		for (const cmd of ["opencode", "ocxo"]) {
			try {
				execSync(`which ${cmd}`, { stdio: "pipe" });
				return { command: cmd, args: ["acp"] };
			} catch { continue; }
		}
		return null;
	},
	codex: () => {
		try {
			execSync("which codex-acp", { stdio: "pipe" });
			return { command: "codex-acp", args: [] };
		} catch { return null; }
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
	if (entries.length === 0) {
		throw new Error("Config must have at least one agent_server");
	}

	const agent_servers: Record<string, AcpAgentConfig> = {};
	for (const [name, agent] of entries) {
		// EC-16: Validate agent name is non-empty
		if (!name || name.trim() === "") {
			throw new Error("Agent name must be a non-empty string");
		}

		if (!agent || typeof agent !== "object") {
			throw new Error(`Invalid agent config for "${name}": must be an object`);
		}
		if (
			!("command" in agent) ||
			typeof agent.command !== "string" ||
			!agent.command
		) {
			throw new Error(
				`Invalid agent config for "${name}": "command" is required`,
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
		circuitBreakerMaxFailures:
			partial.circuitBreakerMaxFailures ??
			DEFAULT_CONFIG.circuitBreakerMaxFailures,
		circuitBreakerResetMs:
			partial.circuitBreakerResetMs ?? DEFAULT_CONFIG.circuitBreakerResetMs,
		modelPolicy: {
			...DEFAULT_CONFIG.modelPolicy,
			...partial.modelPolicy,
		},
		toolTimeouts: partial.toolTimeouts
			? { ...partial.toolTimeouts }
			: undefined,
	};

	// EC-20: Validate numeric fields are non-negative
	validateNumericFields(resolved);
	// EC-21: Validate healthCheckIntervalMs <= staleTimeoutMs
	validateTimeoutOrder(resolved);

	return resolved;
}

/** Validate numeric timeout fields are non-negative (EC-20) */
function validateNumericFields(resolved: AcpConfig): void {
	const numericFields: Array<[string, number | undefined]> = [
		["staleTimeoutMs", resolved.staleTimeoutMs],
		["healthCheckIntervalMs", resolved.healthCheckIntervalMs],
		["circuitBreakerResetMs", resolved.circuitBreakerResetMs],
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
			} catch { /* best-effort */ }
		}

		return validateConfig(migrated);
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
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

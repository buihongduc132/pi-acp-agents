/**
 * pi-acp-agents — Config loading and validation
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AcpConfig, AcpAgentConfig } from "./types.js";

const CONFIG_PATH = join(homedir(), ".pi", "acp-agents", "config.json");

export const DEFAULT_CONFIG: AcpConfig = {
  agents: {},
  staleTimeoutMs: 900_000,
  healthCheckIntervalMs: 30_000,
  circuitBreakerMaxFailures: 3,
  circuitBreakerResetMs: 60_000,
  stallTimeoutMs: 300_000, // 5 minutes default stall timeout
};

export function resolveConfigPath(): string {
  return CONFIG_PATH;
}

/** Validate a partial config. Throws on invalid. Returns full config with defaults merged. */
export function validateConfig(partial: Partial<AcpConfig>): AcpConfig {
  if (!partial.agents || typeof partial.agents !== "object") {
    throw new Error('Config must have an "agents" object');
  }

  const entries = Object.entries(partial.agents);
  if (entries.length === 0) {
    throw new Error("Config must have at least one agent");
  }

  const agents: Record<string, AcpAgentConfig> = {};
  for (const [name, agent] of entries) {
    // EC-16: Validate agent name is non-empty
    if (!name || name.trim() === "") {
      throw new Error("Agent name must be a non-empty string");
    }

    if (!agent || typeof agent !== "object") {
      throw new Error(`Invalid agent config for "${name}": must be an object`);
    }
    if (!("command" in agent) || typeof agent.command !== "string" || !agent.command) {
      throw new Error(`Invalid agent config for "${name}": "command" is required`);
    }
    agents[name] = {
      ...agent,
      args: agent.args ?? [],
      env: agent.env ?? {},
      // Level 2 passthrough fields — just passed through, not validated
      thinkingLevel: agent.thinkingLevel,
      sandbox: agent.sandbox,
      skipTrust: agent.skipTrust,
      mcpServers: agent.mcpServers,
    };
  }

  const resolved: AcpConfig = {
    ...DEFAULT_CONFIG,
    ...partial,
    agents,
    staleTimeoutMs: partial.staleTimeoutMs ?? DEFAULT_CONFIG.staleTimeoutMs,
    healthCheckIntervalMs: partial.healthCheckIntervalMs ?? DEFAULT_CONFIG.healthCheckIntervalMs,
    circuitBreakerMaxFailures: partial.circuitBreakerMaxFailures ?? DEFAULT_CONFIG.circuitBreakerMaxFailures,
    circuitBreakerResetMs: partial.circuitBreakerResetMs ?? DEFAULT_CONFIG.circuitBreakerResetMs,
  };

  // EC-20: Validate numeric fields are non-negative
  validateNumericFields(resolved);
  // EC-21: Validate healthCheckIntervalMs <= staleTimeoutMs
  validateTimeoutOrder(resolved);

  return resolved;
}

/** Validate numeric timeout fields are non-negative (EC-20) */
function validateNumericFields(resolved: AcpConfig): void {
  const numericFields: Array<[string, number]> = [
    ["staleTimeoutMs", resolved.staleTimeoutMs],
    ["healthCheckIntervalMs", resolved.healthCheckIntervalMs],
    ["circuitBreakerResetMs", resolved.circuitBreakerResetMs],
  ];
  for (const [field, val] of numericFields) {
    if (val !== undefined && val < 0) {
      throw new Error(`Config field "${field}" must be non-negative`);
    }
  }
  if (resolved.circuitBreakerMaxFailures !== undefined && resolved.circuitBreakerMaxFailures < 0) {
    throw new Error('Config field "circuitBreakerMaxFailures" must be non-negative');
  }
}

/** Validate healthCheckIntervalMs <= staleTimeoutMs (EC-21) */
function validateTimeoutOrder(resolved: AcpConfig): void {
  if (resolved.healthCheckIntervalMs! > resolved.staleTimeoutMs!) {
    throw new Error("healthCheckIntervalMs must be <= staleTimeoutMs");
  }
}

/** Load config from disk, falling back to defaults */
export function loadConfig(configPath?: string): AcpConfig {
  const path = configPath ?? CONFIG_PATH;
  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AcpConfig>;
    return validateConfig(parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Get a specific agent config, throwing if not found */
export function getAgentConfig(config: AcpConfig, name: string): AcpAgentConfig {
  const agent = config.agents[name];
  if (!agent) {
    const available = Object.keys(config.agents).join(", ");
    throw new Error(`Agent "${name}" not found. Available: ${available}`);
  }
  return agent;
}

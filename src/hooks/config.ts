/**
 * loadHookConfig / validateHookConfig — per-hook enable/disable (LD3).
 *
 * Reads a hook config JSON file. Malformed/missing/empty → returns defaults
 * with a console.warn (graceful, never throws into the main workflow).
 *
 * Spec said "throws on invalid", but the RED tests mandate graceful
 * warn-and-fallback behavior (TDD: tests are source of truth in GREEN).
 */
import { readFileSync, existsSync } from "node:fs";

import {
	DEFAULT_HOOK_CONFIG,
	defaultHooksDir,
} from "./types.js";
import type {
	FailureAction,
	FollowupOwner,
	HookConfig,
	HookEventConfig,
	HookEventName,
} from "./types.js";

const VALID_FAILURE_ACTIONS: ReadonlySet<FailureAction> = new Set([
	"warn",
	"followup",
	"reopen",
	"reopen_followup",
]);

const VALID_FOLLOWUP_OWNERS: ReadonlySet<FollowupOwner> = new Set([
	"member",
	"lead",
	"none",
]);

const MIN_MAX_MESSAGE_SIZE = 1024;

/**
 * Default config path: `<hooksDir>/config.json`.
 */
function defaultConfigPath(hooksDir: string = defaultHooksDir()): string {
	return `${hooksDir}/config.json`;
}

/**
 * Returns a fresh deep clone of DEFAULT_HOOK_CONFIG.
 * Callers may mutate the return value safely.
 */
function getDefaultConfig(): HookConfig {
	return cloneConfig(DEFAULT_HOOK_CONFIG);
}

/**
 * Frozen default config snapshot for direct import.
 */
export const defaultConfig: HookConfig = Object.freeze(
	cloneConfig(DEFAULT_HOOK_CONFIG),
) as HookConfig;

function cloneConfig(cfg: HookConfig): HookConfig {
	return {
		version: 1,
		enabled: cfg.enabled,
		hooks: { ...cfg.hooks },
		failureAction: cfg.failureAction,
		followupOwner: cfg.followupOwner,
		maxReopensPerTask: cfg.maxReopensPerTask,
		socket: { ...cfg.socket },
	};
}

function warn(msg: string): void {
	// eslint-disable-next-line no-console
	console.warn(`[acp-hooks/config] ${msg}`);
}

/**
 * Validate + normalize a raw config object into a well-formed HookConfig.
 *
 * Graceful: invalid scalar values are warned about and replaced with
 * defaults (never throws). Structural problems also fall back.
 */
export function validateHookConfig(raw: unknown): HookConfig {
	const base = getDefaultConfig();

	if (!isObject(raw)) {
		warn("config is not an object — using defaults");
		return base;
	}

	const cfg = raw as Record<string, unknown>;

	// version
	if (cfg.version === 1) {
		base.version = 1;
	} else if (cfg.version !== undefined) {
		warn(`config.version must be 1, got ${String(cfg.version)} — forcing 1`);
	}

	// global enabled
	if (cfg.enabled !== undefined) {
		if (typeof cfg.enabled === "boolean") {
			base.enabled = cfg.enabled;
		} else {
			warn("config.enabled must be boolean — using default true");
		}
	}

	// failureAction
	const fa = cfg.failureAction as FailureAction;
	if (cfg.failureAction !== undefined) {
		if (typeof cfg.failureAction === "string" && VALID_FAILURE_ACTIONS.has(fa)) {
			base.failureAction = fa;
		} else {
			warn(
				`config.failureAction "${String(cfg.failureAction)}" is invalid — falling back to "warn"`,
			);
		}
	}

	// followupOwner
	const fo = cfg.followupOwner as FollowupOwner;
	if (cfg.followupOwner !== undefined) {
		if (
			typeof cfg.followupOwner === "string" &&
			VALID_FOLLOWUP_OWNERS.has(fo)
		) {
			base.followupOwner = fo;
		} else {
			warn(
				`config.followupOwner "${String(cfg.followupOwner)}" is invalid — falling back to "lead"`,
			);
		}
	}

	// maxReopensPerTask
	if (cfg.maxReopensPerTask !== undefined) {
		const n = Number(cfg.maxReopensPerTask);
		if (Number.isFinite(n) && n >= 0) {
			base.maxReopensPerTask = Math.floor(n);
		} else {
			warn(
				`config.maxReopensPerTask ${String(cfg.maxReopensPerTask)} is invalid — falling back to ${DEFAULT_HOOK_CONFIG.maxReopensPerTask}`,
			);
		}
	}

	// per-hook config (LD3)
	if (cfg.hooks !== undefined) {
		if (isObject(cfg.hooks)) {
			for (const [k, v] of Object.entries(cfg.hooks as Record<string, unknown>)) {
				const parsed = parseHookEventConfig(k, v);
				if (parsed) {
					base.hooks[parsed.name] = parsed.config;
				}
			}
		} else {
			warn("config.hooks must be an object — ignoring");
		}
	}

	// socket
	if (cfg.socket !== undefined) {
		if (isObject(cfg.socket)) {
			base.socket = parseSocketConfig(cfg.socket as Record<string, unknown>);
		} else {
			warn("config.socket must be an object — ignoring");
		}
	}

	return base;
}

function parseHookEventConfig(
	key: string,
	value: unknown,
): { name: HookEventName; config: HookEventConfig } | null {
	const validNames: ReadonlySet<string> = new Set([
		"session_started",
		"session_completed",
		"session_failed",
		"session_idle",
		"subagent_start",
		"subagent_stop",
		"task_assigned",
		"task_completed",
		"task_failed",
	]);
	if (!validNames.has(key)) {
		warn(`unknown hook event "${key}" — ignoring`);
		return null;
	}
	if (!isObject(value)) {
		warn(`hooks.${key} must be an object — ignoring`);
		return null;
	}
	const v = value as Record<string, unknown>;
	const enabled =
		typeof v.enabled === "boolean" ? v.enabled : true;
	const timeoutMsNum = Number(v.timeoutMs);
	const timeoutMs =
		Number.isFinite(timeoutMsNum) && timeoutMsNum > 0
			? Math.floor(timeoutMsNum)
			: 5000;
	return {
		name: key as HookEventName,
		config: { enabled, timeoutMs },
	};
}

function parseSocketConfig(raw: Record<string, unknown>): HookConfig["socket"] {
	const out = { ...DEFAULT_HOOK_CONFIG.socket };

	if (typeof raw.enabled === "boolean") {
		out.enabled = raw.enabled;
	} else if (raw.enabled !== undefined) {
		warn("socket.enabled must be boolean — using default");
	}

	if (typeof raw.path === "string" && raw.path.length > 0) {
		out.path = raw.path;
	} else if (raw.path !== undefined) {
		warn("socket.path must be a non-empty string — using default");
	}

	const mmsNum = Number(raw.maxMessageSize);
	if (Number.isFinite(mmsNum) && mmsNum >= MIN_MAX_MESSAGE_SIZE) {
		out.maxMessageSize = Math.floor(mmsNum);
	} else if (raw.maxMessageSize !== undefined) {
		warn(
			`socket.maxMessageSize ${String(raw.maxMessageSize)} invalid — clamping to ${MIN_MAX_MESSAGE_SIZE}`,
		);
		out.maxMessageSize = Math.max(
			MIN_MAX_MESSAGE_SIZE,
			Number.isFinite(mmsNum) && mmsNum > 0 ? Math.floor(mmsNum) : 0,
		);
		out.maxMessageSize = Math.max(out.maxMessageSize, MIN_MAX_MESSAGE_SIZE);
	}

	const btmNum = Number(raw.broadcastTimeoutMs);
	if (Number.isFinite(btmNum) && btmNum > 0) {
		out.broadcastTimeoutMs = Math.floor(btmNum);
	} else if (raw.broadcastTimeoutMs !== undefined) {
		warn(
			`socket.broadcastTimeoutMs ${String(raw.broadcastTimeoutMs)} invalid — using default`,
		);
	}

	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load hook config from a JSON file path.
 *
 * - Missing file → defaults (+ warn)
 * - Empty file → defaults (+ warn)
 * - Malformed JSON → defaults (+ warn)
 * - Valid JSON → validateHookConfig(raw)
 *
 * Never throws into the caller (graceful).
 */
export function loadHookConfig(configPath?: string): HookConfig {
	const path = configPath ?? defaultConfigPath();

	if (!existsSync(path)) {
		warn(`config file not found at ${path} — using defaults`);
		return getDefaultConfig();
	}

	let rawText: string;
	try {
		rawText = readFileSync(path, "utf-8");
	} catch (err) {
		warn(`failed to read config at ${path}: ${String(err)} — using defaults`);
		return getDefaultConfig();
	}

	if (rawText.trim() === "") {
		warn(`config file ${path} is empty — using defaults`);
		return getDefaultConfig();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (err) {
		warn(
			`config file ${path} is not valid JSON: ${String(err)} — using defaults`,
		);
		return getDefaultConfig();
	}

	return validateHookConfig(parsed);
}

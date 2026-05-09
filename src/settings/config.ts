/**
 * ACP tool enable/disable settings.
 *
 * Pattern copied from pi-gitnexus-local/config.ts:
 * - Global config at ~/.pi/acp-agents/settings.json
 * - Local (project) config at <cwd>/.pi/acp-agents/settings.json
 * - deepMerge(global, local) with local overriding global per key
 * - DEFAULT_SETTINGS has all tools enabled
 * - Unknown tool names are ignored gracefully
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Tool names ──────────────────────────────────────────

export const ACP_TOOL_NAMES = [
	"acp_prompt",
	"acp_status",
	"acp_session_new",
	"acp_session_load",
	"acp_session_set_model",
	"acp_session_set_mode",
	"acp_cancel",
	"acp_session_list",
	"acp_session_shutdown",
	"acp_session_kill",
	"acp_prune",
	"acp_delegate",
	"acp_broadcast",
	"acp_compare",
	"acp_task_create",
	"acp_task_list",
	"acp_task_get",
	"acp_task_assign",
	"acp_task_set_status",
	"acp_task_dependency_add",
	"acp_task_dependency_remove",
	"acp_task_clear",
	"acp_message_send",
	"acp_message_list",
	"acp_plan_request",
	"acp_plan_resolve",
	"acp_model_policy_get",
	"acp_model_policy_check",
	"acp_doctor",
	"acp_runtime_info",
	"acp_env",
	"acp_event_log",
	"acp_cleanup",
] as const;

export type AcpToolName = (typeof ACP_TOOL_NAMES)[number];

// ── Types ───────────────────────────────────────────────

export interface AcpToolSettings {
	tools: Record<AcpToolName, { enabled: boolean }>;
}

export type AcpToolSettingsInput = {
	tools?: Partial<Record<string, { enabled: boolean }>>;
};

// ── Defaults ────────────────────────────────────────────

function buildDefaultTools(): Record<AcpToolName, { enabled: boolean }> {
	const tools = {} as Record<AcpToolName, { enabled: boolean }>;
	for (const name of ACP_TOOL_NAMES) {
		tools[name] = { enabled: true };
	}
	return tools;
}

export const DEFAULT_SETTINGS: AcpToolSettings = {
	tools: buildDefaultTools(),
};

// ── Deep merge (copied from pi-gitnexus-local/config.ts) ──

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepMergeSettings<T>(base: T, override: unknown): T {
	if (!override) return structuredClone(base);
	if (Array.isArray(base) || Array.isArray(override)) {
		return structuredClone(override as T);
	}
	if (isPlainObject(base) && isPlainObject(override)) {
		const result: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(override)) {
			const current = result[key];
			if (isPlainObject(current) && isPlainObject(value)) {
				result[key] = deepMergeSettings(current, value);
			} else {
				result[key] = structuredClone(value);
			}
		}
		return result as T;
	}
	return structuredClone(override as T);
}

// ── Config file I/O ─────────────────────────────────────

export const GLOBAL_SETTINGS_PATH = resolve(
	homedir(),
	".pi",
	"acp-agents",
	"settings.json",
);

export function getProjectSettingsPath(cwd: string): string {
	return resolve(cwd, ".pi", "acp-agents", "settings.json");
}

function loadJsonLike(path: string): AcpToolSettingsInput | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const stripped = raw.replace(/^\s*\/\/.*$/gm, "").trim();
		if (!stripped) return null;
		return JSON.parse(stripped) as AcpToolSettingsInput;
	} catch {
		return null;
	}
}

export function readGlobalSettings(): AcpToolSettingsInput | null {
	return loadJsonLike(GLOBAL_SETTINGS_PATH);
}

export function writeGlobalSettings(config: AcpToolSettingsInput): void {
	const dir = resolve(homedir(), ".pi", "acp-agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		GLOBAL_SETTINGS_PATH,
		`${JSON.stringify(config, null, 2)}\n`,
		"utf-8",
	);
}

// ── Merge with validation ───────────────────────────────

function validateAndStrip(settings: AcpToolSettingsInput): AcpToolSettingsInput {
	if (!settings?.tools) return { tools: {} };
	const valid: Record<string, { enabled: boolean }> = {};
	for (const name of ACP_TOOL_NAMES) {
		if (settings.tools[name] !== undefined) {
			valid[name] = { enabled: settings.tools[name].enabled };
		}
	}
	return { tools: valid };
}

export function mergeSettingsLayers(
	globalConfig?: AcpToolSettingsInput | null,
	projectConfig?: AcpToolSettingsInput | null,
): AcpToolSettings {
	const validatedGlobal = globalConfig ? validateAndStrip(globalConfig) : null;
	const validatedLocal = projectConfig ? validateAndStrip(projectConfig) : null;
	let merged = deepMergeSettings(DEFAULT_SETTINGS, validatedGlobal);
	merged = deepMergeSettings(merged, validatedLocal);
	return merged;
}

export function loadSettings(cwd: string): AcpToolSettings {
	const projectPath = getProjectSettingsPath(cwd);
	return mergeSettingsLayers(readGlobalSettings(), loadJsonLike(projectPath));
}

export function loadSettingsLayers(cwd: string): {
	global: AcpToolSettingsInput | null;
	local: AcpToolSettingsInput | null;
	merged: AcpToolSettings;
} {
	const global = readGlobalSettings();
	const local = loadJsonLike(getProjectSettingsPath(cwd));
	return { global, local, merged: mergeSettingsLayers(global, local) };
}

// ── Helper ──────────────────────────────────────────────

export function isToolEnabled(settings: AcpToolSettings, toolName: string): boolean {
	const entry = settings.tools[toolName as AcpToolName];
	if (!entry) return true; // unknown tools default to enabled
	return entry.enabled;
}

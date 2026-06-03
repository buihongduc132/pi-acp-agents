/**
 * TDD tests for ACP tool enable/disable settings.
 *
 * Pattern copied from pi-gitnexus-local/config.ts:
 * - Global config at ~/.pi/acp-agents/settings.json
 * - Local config at <cwd>/.pi/acp-agents/settings.json
 * - deepMerge(global, local) with local overriding global per key
 * - DEFAULT_CONFIG has all tools enabled
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We mock homedir so global config goes to a temp dir
// vi.mock is hoisted, so we must compute FAKE_HOME inside the factory
vi.mock("node:os", () => {
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	return {
		homedir: () => join(tmpdir(), `acp-settings-test-${process.pid}`),
	};
});

const FAKE_HOME = (() => {
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	return join(tmpdir(), `acp-settings-test-${process.pid}`);
})();

import {
	ACP_TOOL_NAMES,
	type AcpToolSettings,
	type AcpToolSettingsInput,
	DEFAULT_SETTINGS,
	deepMergeSettings,
	getProjectSettingsPath,
	GLOBAL_SETTINGS_PATH,
	loadSettings,
	loadSettingsLayers,
	readGlobalSettings,
	writeGlobalSettings,
} from "../../src/settings/config.js";

// ── Helpers ──────────────────────────────────────────────

function cleanFakeHome() {
	if (existsSync(FAKE_HOME)) rmSync(FAKE_HOME, { recursive: true, force: true });
}

function writeJson(path: string, data: unknown) {
	mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8"));
}

// ── Tests ────────────────────────────────────────────────

describe("ACP tool settings — config", () => {
	beforeEach(() => { cleanFakeHome(); });
	afterEach(() => { cleanFakeHome(); });

	// ── 1. Default config has all tools enabled ──────────

	it("DEFAULT_SETTINGS has all 33 tools enabled", () => {
		expect(ACP_TOOL_NAMES).toHaveLength(33);
		for (const name of ACP_TOOL_NAMES) {
			expect(DEFAULT_SETTINGS.tools[name]).toBeDefined();
			expect(DEFAULT_SETTINGS.tools[name].enabled).toBe(true);
		}
	});

	it("ACP_TOOL_NAMES contains exact registered tool names", () => {
		const expected = [
			"acp_prompt", "acp_status", "acp_session_new", "acp_session_load",
			"acp_session_set_model", "acp_session_set_mode", "acp_cancel",
			"acp_session_list", "acp_session_shutdown", "acp_session_kill",
			"acp_prune", "acp_delegate", "acp_broadcast", "acp_compare",
			"acp_task_create", "acp_task_list", "acp_task_get", "acp_task_assign",
			"acp_task_set_status", "acp_task_dependency_add", "acp_task_dependency_remove",
			"acp_task_clear", "acp_message_send", "acp_message_list",
			"acp_plan_request", "acp_plan_resolve", "acp_model_policy_get",
			"acp_model_policy_check", "acp_doctor", "acp_runtime_info", "acp_env",
			"acp_event_log", "acp_cleanup",
		];
		expect([...ACP_TOOL_NAMES].sort()).toEqual([...expected].sort());
	});

	// ── 2. Global config overrides specific tools ────────

	it("global config can disable specific tools", () => {
		const global: AcpToolSettingsInput = {
			tools: { acp_delegate: { enabled: false }, acp_broadcast: { enabled: false } },
		};
		writeGlobalSettings(global);
		const loaded = loadSettings("/fake/cwd");
		expect(loaded.tools.acp_delegate.enabled).toBe(false);
		expect(loaded.tools.acp_broadcast.enabled).toBe(false);
		// Others remain enabled
		expect(loaded.tools.acp_prompt.enabled).toBe(true);
		expect(loaded.tools.acp_status.enabled).toBe(true);
	});

	// ── 3. Local config overrides global per key ─────────

	it("local config overrides global per key", () => {
		const global: AcpToolSettingsInput = {
			tools: { acp_delegate: { enabled: false }, acp_broadcast: { enabled: false } },
		};
		writeGlobalSettings(global);

		const cwd = join(FAKE_HOME, "project");
		const localPath = getProjectSettingsPath(cwd);
		const local: AcpToolSettingsInput = {
			tools: { acp_delegate: { enabled: true } }, // re-enable delegate
		};
		writeJson(localPath, local);

		const loaded = loadSettings(cwd);
		expect(loaded.tools.acp_delegate.enabled).toBe(true); // local wins
		expect(loaded.tools.acp_broadcast.enabled).toBe(false); // global still applies
	});

	// ── 4. deepMerge handles partial overrides ───────────

	it("deepMerge preserves unmodified keys", () => {
		const partial: AcpToolSettingsInput = {
			tools: { acp_cleanup: { enabled: false } },
		};
		const merged = deepMergeSettings(DEFAULT_SETTINGS, partial);
		expect(merged.tools.acp_cleanup.enabled).toBe(false);
		expect(merged.tools.acp_prompt.enabled).toBe(true); // preserved
		expect(merged.tools.acp_status.enabled).toBe(true); // preserved
	});

	it("deepMerge with null override returns defaults", () => {
		const merged = deepMergeSettings(DEFAULT_SETTINGS, null);
		expect(merged.tools.acp_prompt.enabled).toBe(true);
	});

	it("deepMerge with empty object returns defaults", () => {
		const merged = deepMergeSettings(DEFAULT_SETTINGS, {});
		expect(merged.tools.acp_prompt.enabled).toBe(true);
	});

	// ── 5. loadSettings merges global + local correctly ──

	it("loadSettings returns defaults when no config files exist", () => {
		const loaded = loadSettings("/nonexistent/cwd");
		for (const name of ACP_TOOL_NAMES) {
			expect(loaded.tools[name].enabled).toBe(true);
		}
	});

	it("loadSettingsLayers returns both layers", () => {
		const global: AcpToolSettingsInput = {
			tools: { acp_prompt: { enabled: false } },
		};
		writeGlobalSettings(global);

		const cwd = join(FAKE_HOME, "project");
		const localPath = getProjectSettingsPath(cwd);
		const local: AcpToolSettingsInput = {
			tools: { acp_prompt: { enabled: true } },
		};
		writeJson(localPath, local);

		const layers = loadSettingsLayers(cwd);
		expect(layers.global?.tools?.acp_prompt?.enabled).toBe(false);
		expect(layers.local?.tools?.acp_prompt?.enabled).toBe(true);
		expect(layers.merged.tools.acp_prompt.enabled).toBe(true); // local wins
	});

	// ── 6. writeGlobalSettings persists and can be re-read

	it("writeGlobalSettings persists and readGlobalSettings returns it", () => {
		const input: AcpToolSettingsInput = {
			tools: { acp_compare: { enabled: false } },
		};
		writeGlobalSettings(input);
		const read = readGlobalSettings();
		expect(read?.tools?.acp_compare?.enabled).toBe(false);
	});

	it("writeGlobalSettings creates parent directories", () => {
		expect(existsSync(join(FAKE_HOME, ".pi", "acp-agents"))).toBe(false);
		writeGlobalSettings({ tools: { acp_cleanup: { enabled: false } } });
		expect(existsSync(GLOBAL_SETTINGS_PATH)).toBe(true);
	});

	// ── 7. Unknown tool names are ignored gracefully ─────

	it("unknown tool names in config are ignored without error", () => {
		const global: any = {
			tools: {
				acp_prompt: { enabled: false },
				acp_nonexistent_tool: { enabled: true },
			},
		};
		writeGlobalSettings(global);
		const loaded = loadSettings("/fake/cwd");
		expect(loaded.tools.acp_prompt.enabled).toBe(false);
		// acp_nonexistent_tool should not appear in the result
		expect((loaded.tools as any).acp_nonexistent_tool).toBeUndefined();
	});

	// ── 8. isToolEnabled helper ──────────────────────────

	it("isToolEnabled returns correct state for each tool", async () => {
		const { isToolEnabled } = await import("../../src/settings/config.js");
		writeGlobalSettings({ tools: { acp_delegate: { enabled: false } } });
		const settings = loadSettings("/fake/cwd");
		expect(isToolEnabled(settings, "acp_delegate")).toBe(false);
		expect(isToolEnabled(settings, "acp_prompt")).toBe(true);
	});

	it("isToolEnabled returns true for unknown tool names", async () => {
		const { isToolEnabled } = await import("../../src/settings/config.js");
		const settings = loadSettings("/fake/cwd");
		expect(isToolEnabled(settings, "acp_nonexistent")).toBe(true);
	});

	// ── 9. Config paths ──────────────────────────────────

	it("GLOBAL_SETTINGS_PATH points to ~/.pi/acp-agents/settings.json", () => {
		expect(GLOBAL_SETTINGS_PATH).toContain(".pi");
		expect(GLOBAL_SETTINGS_PATH).toContain("acp-agents");
		expect(GLOBAL_SETTINGS_PATH).toContain("settings.json");
	});

	it("getProjectSettingsPath returns <cwd>/.pi/acp-agents/settings.json", () => {
		const path = getProjectSettingsPath("/my/project");
		expect(path).toBe("/my/project/.pi/acp-agents/settings.json");
	});
});

/**
 * TUI settings wizard for ACP tool enable/disable.
 *
 * Pattern copied from pi-gitnexus-local/index.ts configureExtension():
 * Uses ctx.ui.confirm(), ctx.ui.select(), ctx.ui.input() for interactive settings.
 * NOT ctx.ui.custom().
 */

import type { AcpToolSettings, AcpToolSettingsInput, AcpToolName } from "./config.js";
import { ACP_TOOL_NAMES, readGlobalSettings, writeGlobalSettings, loadSettings } from "./config.js";

const TOOL_GROUPS: { label: string; tools: AcpToolName[] }[] = [
	{
		label: "Core",
		tools: ["acp_prompt", "acp_status"],
	},
	{
		label: "Session",
		tools: [
			"acp_session_new", "acp_session_load", "acp_session_set_model",
			"acp_session_set_mode", "acp_cancel",
		],
	},
	{
		label: "Lifecycle",
		tools: ["acp_session_list", "acp_session_shutdown", "acp_session_kill", "acp_prune"],
	},
	{
		label: "Coordination",
		tools: ["acp_delegate", "acp_broadcast", "acp_compare"],
	},
	{
		label: "Task",
		tools: [
			"acp_task_create", "acp_task_list", "acp_task_get", "acp_task_assign",
			"acp_task_set_status", "acp_task_dependency_add", "acp_task_dependency_remove",
			"acp_task_clear",
		],
	},
	{
		label: "Message",
		tools: ["acp_message_send", "acp_message_list"],
	},
	{
		label: "Governance",
		tools: ["acp_plan_request", "acp_plan_resolve", "acp_model_policy_get", "acp_model_policy_check"],
	},
	{
		label: "Runtime",
		tools: ["acp_doctor", "acp_runtime_info", "acp_env", "acp_event_log", "acp_cleanup"],
	},
];

export async function configureToolSettings(
	ctx: {
		hasUI: boolean;
		ui: {
			confirm(title: string, body: string): Promise<boolean>;
			input(prompt: string, placeholder?: string): Promise<string | undefined>;
			notify(message: string, type: "info" | "warning" | "error"): void;
			select(prompt: string, items: string[]): Promise<string | undefined>;
		};
	},
	cwd: string,
): Promise<AcpToolSettings | null> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Interactive UI required for ACP settings", "warning");
		return null;
	}

	const current = loadSettings(cwd);
	const base = structuredClone(readGlobalConfigForEdit());

	// Ask which group to configure
	while (true) {
		const groupLabels = TOOL_GROUPS.map((g) => {
			const enabled = g.tools.filter((t) => current.tools[t].enabled).length;
			return `${g.label} (${enabled}/${g.tools.length})`;
		});
		groupLabels.push("Done");

		const choice = await ctx.ui.select(
			"ACP tool settings — pick a group to configure",
			groupLabels,
		);

		if (!choice || choice === "Done") break;

		const groupIndex = groupLabels.indexOf(choice);
		const group = TOOL_GROUPS[groupIndex];

		// Toggle individual tools in the group
		for (const toolName of group.tools) {
			const isEnabled = base.tools?.[toolName]?.enabled ?? current.tools[toolName].enabled;
			const toggle = await ctx.ui.select(
				`${toolName}`,
				[
					isEnabled ? "✓ enabled (keep)" : "○ disabled (keep)",
					isEnabled ? "Disable" : "Enable",
				],
			);
			if (toggle?.startsWith("Enable") || toggle?.startsWith("Disable")) {
				if (!base.tools) base.tools = {};
				base.tools[toolName] = { enabled: toggle.startsWith("Enable") };
			}
		}

		// Refresh current view
		for (const toolName of group.tools) {
			if (base.tools?.[toolName] !== undefined) {
				current.tools[toolName] = { enabled: base.tools[toolName].enabled };
			}
		}
	}

	// Check if anything changed
	const hasChanges = Object.keys(base.tools ?? {}).length > 0;
	if (!hasChanges) {
		ctx.ui.notify("No changes made.", "info");
		return null;
	}

	// Save
	writeGlobalSettings(base);
	ctx.ui.notify(
		"ACP tool settings saved to global config.\nRestart pi for tool changes to take effect.",
		"info",
	);
	return loadSettings(cwd);
}

function readGlobalConfigForEdit(): AcpToolSettingsInput {
	const raw = readGlobalSettings();
	return raw ? structuredClone(raw) : { tools: {} };
}

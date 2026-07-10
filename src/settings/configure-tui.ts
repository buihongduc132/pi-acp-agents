/**
 * TUI settings wizard for ACP tool enable/disable.
 *
 * Pattern copied from pi-gitnexus-local/index.ts configureExtension():
 * Uses ctx.ui.confirm(), ctx.ui.select(), ctx.ui.input() for interactive settings.
 * NOT ctx.ui.custom().
 */

import type { AcpToolSettings, AcpToolSettingsInput, AcpToolName } from "./config.js";
import { ACP_TOOL_NAMES, readGlobalSettings, writeGlobalSettings, loadSettings } from "./config.js";

// Unified ACP core tools (the 7 consolidated surface) plus legacy aliases
// for backward-compat. Legacy aliases map to the unified tool that now
// provides the capability (OR-gate in index.ts honors legacy config keys).
const TOOL_GROUPS: { label: string; tools: AcpToolName[] }[] = [
	{
		label: "Spawn & prompt (core)",
		tools: ["acp_spawn"],
	},
	{
		label: "Messaging",
		tools: [
			"acp_msg",
			"acp_message", // legacy alias → acp_msg (OR-gate)
		],
	},
	{
		label: "Governance",
		tools: ["acp_governance"],
	},
	{
		label: "Status & lifecycle",
		tools: ["acp_status"],
	},
	{
		label: "Fan-out (broadcast/compare)",
		tools: ["acp_fanout"],
	},
	{
		label: "Tasks",
		tools: [
			"acp_task",
			"acp_task_create", // legacy alias → acp_task (OR-gate)
			"acp_task_update", // legacy alias → acp_task (OR-gate)
		],
	},
	{
		label: "DAG delegation",
		tools: [
			"acp_dag",
			"acp_dag_submit", // legacy alias → acp_dag (OR-gate)
			"acp_dag_status", // legacy alias → acp_dag (OR-gate)
			"acp_dag_cancel", // legacy alias → acp_dag (OR-gate)
		],
	},
	{
		label: "Hooks policy",
		tools: ["acp_hooks_policy_get", "acp_hooks_policy_set"],
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
			const enabled = g.tools.filter((t) => current.tools[t]?.enabled).length;
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
			const isEnabled = base.tools?.[toolName]?.enabled ?? current.tools[toolName]?.enabled ?? false;
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
				current.tools[toolName] = { enabled: base.tools[toolName]?.enabled ?? false };
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

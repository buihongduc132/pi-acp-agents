/**
 * agent-config-tui.ts — Interactive TUI panel for managing agent_servers.
 *
 * Pattern: ui.custom() + SettingsList from @mariozechner/pi-tui.
 * Design: rebuild-on-change — SettingsList is static, so on add/remove agent
 * we dispose and rebuild the entire list.
 *
 * CRITICAL: SettingsList.activateItem() gives `submenu` precedence over `values`
 * cycling. When an item has BOTH `submenu` and `values`, Enter always opens
 * the submenu and the values cycle path is unreachable. Therefore:
 * - Agent rows use submenu as an ACTION MENU (Edit/Remove/Set Default/Cancel)
 * - Add Agent uses submenu for manual/preset entry
 * - Default Agent uses `values` only (no submenu)
 */

import { Container, Input, type SettingItem, SettingsList, Spacer, Text } from "@mariozechner/pi-tui";
import {
	loadConfig,
	saveConfig,
	upsertAgentServer,
	removeAgentServer,
	setDefaultAgent,
	detectAvailablePresets,
} from "../config/config.js";
import type { AcpAgentConfig, AcpConfig } from "../config/types.js";

// ── Types ────────────────────────────────────────────────

export type SettingItemWithMeta = SettingItem;

export type SettingsUI = {
	custom<T>(
		factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
		options?: { overlay?: boolean; overlayOptions?: any },
	): Promise<T>;
};

// ── Description formatting ───────────────────────────────

function formatAgentDescription(agent: AcpAgentConfig): string {
	const parts: string[] = [`command: ${agent.command}`];
	if (agent.args && agent.args.length > 0) {
		parts.push(`args: ${agent.args.join(" ")}`);
	}
	if (agent.default_model) {
		parts.push(`model: ${agent.default_model}`);
	}
	if (agent.default_mode) {
		parts.push(`mode: ${agent.default_mode}`);
	}
	return parts.join(" | ");
}

// ── Build SettingItems from config ───────────────────────

/**
 * Build the array of SettingItem entries for the agent config TUI.
 * Exported for testing — pure function, no UI dependency.
 */
export function buildSettingItems(
	config: AcpConfig,
	detectedPresets: Array<{ name: string; config: AcpAgentConfig }>,
): SettingItemWithMeta[] {
	const items: SettingItemWithMeta[] = [];
	const agentNames = Object.keys(config.agent_servers);

	// Agent items — submenu as action menu (Edit/Remove/Set Default/Cancel)
	for (const name of agentNames) {
		const agent = config.agent_servers[name];
		const isDefault = config.defaultAgent === name;
		items.push({
			id: `agent:${name}`,
			label: `${isDefault ? "★ " : ""}${name}`,
			description: formatAgentDescription(agent),
			currentValue: "Edit",
			// NOTE: values are shown for display but submenu takes precedence on Enter.
			// The submenu acts as the action picker.
			values: ["Edit", "Remove", "Set Default"],
			submenu: (_currentValue, finish) => {
				return createActionMenu(name, agent, isDefault, finish);
			},
		});
	}

	// Empty state hint
	if (agentNames.length === 0) {
		items.push({
			id: "empty:hint",
			label: "(no agents)",
			description: "No agent servers configured. Use 'Add Agent' below to get started.",
			currentValue: "",
		});
	}

	// Add Agent section
	const presetNames = detectedPresets.map((p) => p.name);
	const addDescription = presetNames.length > 0
		? `Detected on PATH: ${presetNames.join(", ")}. Select to add, or enter manually.`
		: "Enter agent name and command manually.";
	items.push({
		id: "preset:add",
		label: "＋ Add Agent",
		description: addDescription,
		currentValue: presetNames.length > 0 ? presetNames[0] : "manual",
		values: presetNames.length > 0 ? [...presetNames, "(manual)"] : undefined,
		submenu: (currentValue, finish) => {
			return createAddSubmenu(currentValue, detectedPresets, finish);
		},
	});

	// Default Agent global setting — values ONLY (no submenu), so cycling works
	if (agentNames.length > 0) {
		items.push({
			id: "global:defaultAgent",
			label: "Default Agent",
			description: "The agent used when no agent name is specified.",
			currentValue: config.defaultAgent ?? "(none)",
			values: [...agentNames, "(none)"],
		});
	}

	return items;
}

// ── Submenu factories ────────────────────────────────────

/**
 * Create an action menu for an agent row.
 * Since SettingsList gives submenu precedence, this IS the interaction surface.
 * Returns a submenu that shows choices and dispatches the selected action.
 */
function createActionMenu(
	agentName: string,
	agent: AcpAgentConfig,
	isDefault: boolean,
	finish: (value?: string) => void,
): { render: (w: number) => string[]; handleInput: (data: string) => void; invalidate: () => void } {
	// Choices: e=edit, r=remove, d=set default, Enter on selection, Esc=cancel
	const choices = [
		{ key: "e", label: "Edit", action: "edit" },
		{ key: "r", label: "Remove", action: "remove" },
	];
	if (!isDefault) {
		choices.push({ key: "d", label: "Set Default", action: "setDefault" });
	}

	let editMode = false;
	let commandInput: Input | undefined;
	let argsInput: Input | undefined;
	let modelInput: Input | undefined;
	let activeField: "command" | "args" | "model" = "command";

	function initEditFields(): void {
		commandInput = new Input();
		commandInput.setValue(agent.command);
		commandInput.focused = true;
		argsInput = new Input();
		argsInput.setValue((agent.args ?? []).join(", "));
		modelInput = new Input();
		modelInput.setValue(agent.default_model ?? "");
		activeField = "command";
		editMode = true;
	}

	function render(w: number): string[] {
		if (editMode && commandInput) {
			const prefix = (label: string, field: string) =>
				field === activeField ? `▸ ${label}: ` : `  ${label}: `;
			return [
				`Edit agent "${agentName}" (Tab=next field, Enter=save, Esc=cancel)`,
				prefix("Command", activeField) + commandInput.render(w).join(""),
				prefix("Args (comma-sep)", activeField) + argsInput!.render(w).join(""),
				prefix("Default model", activeField) + modelInput!.render(w).join(""),
			];
		}

		const lines = [
			`Agent: ${agentName} — choose action`,
			"",
		];
		for (const c of choices) {
			lines.push(`  [${c.key}] ${c.label}`);
		}
		lines.push("  [Esc] Cancel");
		return lines;
	}

	function handleInput(data: string): void {
		if (editMode && commandInput) {
			// Edit mode: Tab/Enter/Esc + field input
			if (data === "\t") {
				activeField = activeField === "command" ? "args" : activeField === "args" ? "model" : "command";
				commandInput.focused = activeField === "command";
				argsInput!.focused = activeField === "args";
				modelInput!.focused = activeField === "model";
				return;
			}
			if (data === "\x1b") {
				finish(undefined);
				return;
			}
			if (data === "\r") {
				const cmd = commandInput.getValue().trim();
				if (!cmd) {
					finish(undefined);
					return;
				}
				const argsStr = argsInput!.getValue().trim();
				const model = modelInput!.getValue().trim();
				finish(JSON.stringify({
					action: "edit",
					agent: agentName,
					command: cmd,
					args: argsStr ? argsStr.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
					default_model: model || undefined,
				}));
				return;
			}
			// Forward to active input
			if (activeField === "command") commandInput.handleInput(data);
			else if (activeField === "args") argsInput!.handleInput(data);
			else modelInput!.handleInput(data);
			return;
		}

		// Action menu mode
		if (data === "\x1b") {
			finish(undefined);
			return;
		}
		const lower = data.toLowerCase();
		for (const c of choices) {
			if (lower === c.key) {
				if (c.action === "edit") {
					initEditFields();
					return;
				}
				// Remove / SetDefault: dispatch immediately
				finish(JSON.stringify({ action: c.action, agent: agentName }));
				return;
			}
		}
	}

	function invalidate(): void {
		if (editMode) {
			commandInput?.invalidate();
			argsInput?.invalidate();
			modelInput?.invalidate();
		}
	}

	return { render, handleInput, invalidate };
}

/** Create add submenu — either from preset or manual entry. */
function createAddSubmenu(
	currentValue: string,
	detectedPresets: Array<{ name: string; config: AcpAgentConfig }>,
	finish: (value?: string) => void,
): { render: (w: number) => string[]; handleInput: (data: string) => void; invalidate: () => void } {
	const preset = detectedPresets.find((p) => p.name === currentValue);

	const nameInput = new Input();
	nameInput.setValue(preset ? preset.name : "");
	nameInput.focused = true;

	const commandInput = new Input();
	commandInput.setValue(preset ? preset.config.command : "");

	const argsInput = new Input();
	argsInput.setValue(preset ? (preset.config.args ?? []).join(", ") : "");

	let activeField: "name" | "command" | "args" = "name";

	function render(w: number): string[] {
		const prefix = (label: string, field: string) =>
			field === activeField ? `▸ ${label}: ` : `  ${label}: `;
		return [
			`Add agent (Tab=next, Enter=add, Esc=cancel)${preset ? ` [preset: ${preset.name}]` : ""}`,
			prefix("Name", activeField) + nameInput.render(w).join(""),
			prefix("Command", activeField) + commandInput.render(w).join(""),
			prefix("Args (comma-sep)", activeField) + argsInput.render(w).join(""),
		];
	}

	function handleInput(data: string): void {
		if (data === "\t") {
			activeField = activeField === "name" ? "command" : activeField === "command" ? "args" : "name";
			nameInput.focused = activeField === "name";
			commandInput.focused = activeField === "command";
			argsInput.focused = activeField === "args";
			return;
		}
		if (data === "\x1b") {
			finish(undefined);
			return;
		}
		if (data === "\r") {
			const name = nameInput.getValue().trim();
			const cmd = commandInput.getValue().trim();
			if (!name || !cmd) {
				finish(undefined);
				return;
			}
			const argsStr = argsInput.getValue().trim();
			finish(JSON.stringify({
				action: "add",
				name,
				command: cmd,
				args: argsStr ? argsStr.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
			}));
			return;
		}
		if (activeField === "name") nameInput.handleInput(data);
		else if (activeField === "command") commandInput.handleInput(data);
		else argsInput.handleInput(data);
	}

	function invalidate(): void {
		nameInput.invalidate();
		commandInput.invalidate();
		argsInput.invalidate();
	}

	return { render, handleInput, invalidate };
}

// ── Submenu result handler ───────────────────────────────

/**
 * Parse a JSON payload from a submenu finish() call and apply the action.
 * Returns true if config was mutated (caller should rebuildList).
 */
function handleSubmenuResult(payload: string, configRef: { config: AcpConfig }): boolean {
	let parsed: { action: string; agent?: string; name?: string; command?: string; args?: string[]; default_model?: string };
	try {
		parsed = JSON.parse(payload);
	} catch {
		return false;
	}

	switch (parsed.action) {
		case "edit": {
			if (!parsed.agent) return false;
			if (!parsed.command) return false;
			configRef.config = upsertAgentServer(configRef.config, parsed.agent, {
				command: parsed.command,
				args: parsed.args,
				default_model: parsed.default_model,
			});
			saveConfig(configRef.config);
			return true;
		}
		case "remove": {
			if (!parsed.agent) return false;
			configRef.config = removeAgentServer(configRef.config, parsed.agent);
			saveConfig(configRef.config);
			return true;
		}
		case "setDefault": {
			if (!parsed.agent) return false;
			try {
				configRef.config = setDefaultAgent(configRef.config, parsed.agent);
				saveConfig(configRef.config);
			} catch { /* ignore */ }
			return true;
		}
		case "add": {
			if (!parsed.name || !parsed.command) return false;
			configRef.config = upsertAgentServer(configRef.config, parsed.name, {
				command: parsed.command,
				args: parsed.args,
			});
			saveConfig(configRef.config);
			return true;
		}
		default:
			return false;
	}
}

// ── Main TUI panel ───────────────────────────────────────

/**
 * Open the agent config TUI panel.
 * Uses ui.custom() + SettingsList. Rebuilds on every mutation.
 */
export async function openAgentConfigTUI(ui: SettingsUI): Promise<void> {
	await ui.custom((_tui, theme, _kb, done) => {
		const configRef = { config: loadConfig() };
		let detectedPresets = detectAvailablePresets();
		let list: SettingsList;
		let container: Container;

		function rebuildList(): void {
			const items = buildSettingItems(configRef.config, detectedPresets);
			const maxVisible = Math.min(items.length + 2, 20);

			list = new SettingsList(
				items,
				maxVisible,
				{
					label: (text, selected) => selected ? theme.bold(theme.fg("accent", text)) : text,
					value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("dim", text),
					description: (text) => theme.fg("dim", text),
					cursor: "❯",
					hint: (text) => theme.fg("dim", text),
				},
				// onChange — handles Default Agent cycling (values-only items)
				(id, newValue) => {
					if (id === "global:defaultAgent") {
						if (newValue === "(none)") {
							configRef.config = { ...configRef.config, defaultAgent: undefined };
						} else {
							try {
								configRef.config = setDefaultAgent(configRef.config, newValue);
							} catch { return; }
						}
						saveConfig(configRef.config);
						rebuildList();
						return;
					}

					// Agent rows and preset:add are handled by submenu → onChange receives
					// the JSON payload from finish(). Parse and dispatch.
					if (id.startsWith("agent:") || id === "preset:add") {
						if (handleSubmenuResult(newValue, configRef)) {
							rebuildList();
						}
						return;
					}
				},
				() => done(undefined),
				{ enableSearch: true },
			);

			container = new Container();
			container.addChild(new Text(theme.bold(theme.fg("accent", "⚙  ACP Agent Configuration")), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(list);
		}

		rebuildList();

		return {
			render: (w: number) => container.render(w),
			invalidate: () => { list.invalidate(); container.invalidate(); },
			handleInput: (data: string) => list.handleInput(data),
		};
	});
}

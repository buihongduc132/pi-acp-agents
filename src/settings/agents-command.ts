/**
 * agents-command.ts — Handler for /acp agents <add|remove|list|config>.
 *
 * Extracted from index.ts for testability. Pure logic + ctx.ui.notify calls.
 * No pi.registerCommand dependency.
 */

import {
	loadConfig,
	saveConfig,
	upsertAgentServer,
	removeAgentServer,
	AGENT_PRESETS,
} from "../config/config.js";
import type { SettingsUI } from "./agent-config-tui.js";

// Re-export so index.ts can import from here
export { openAgentConfigTUI } from "./agent-config-tui.js";

// ── Types ────────────────────────────────────────────────

export interface AgentsCommandCtx {
	ui: {
		notify(message: string, type: "info" | "warning" | "error"): void;
	};
}

// ── Handler ──────────────────────────────────────────────

/**
 * Handle /acp agents subcommands.
 *
 * @param tokens - Parsed tokens after "agents" (e.g. ["add", "gemini", "--command", "gemini"])
 * @param ctx - Context with ui.notify
 */
export async function handleAgentsCommand(
	tokens: string[],
	ctx: AgentsCommandCtx,
): Promise<void> {
	const [subcommand] = tokens;

	if (subcommand === "config") {
		const { openAgentConfigTUI } = await import("./agent-config-tui.js");
		try {
			await openAgentConfigTUI(ctx.ui as unknown as SettingsUI);
		} catch (e) {
			ctx.ui.notify("Failed to open agent config TUI.", "error");
		}
		return;
	}

	if (subcommand === "list") {
		const cfg = loadConfig();
		const agentLines = Object.entries(cfg.agent_servers)
			.map(([name, a]) => {
				const isDefault = cfg.defaultAgent === name ? " (default)" : "";
				const desc =
					typeof a.description === "string" && a.description.length > 0
						? a.description
						: "(no description)";
				return `  ${name}: ${a.command} ${(a.args ?? []).join(" ")} — ${desc}${isDefault}`;
			})
			.join("\n");
		ctx.ui.notify(
			`Agent Servers:\n${agentLines || "  (none)"}\n\nDefault: ${cfg.defaultAgent ?? "none"}`,
			"info",
		);
		return;
	}

	if (subcommand === "add") {
		const name = tokens[1];
		if (!name) {
			ctx.ui.notify(
				"Usage: /acp agents add <name> [--command <cmd>] [--args <a1,a2>] [--model <m>]",
				"error",
			);
			return;
		}
		// Parse optional flags
		let command = "";
		let args: string[] = [];
		let model = "";
		for (let i = 2; i < tokens.length; i++) {
			if (tokens[i] === "--command" && tokens[i + 1]) {
				command = tokens[++i]!;
			} else if (tokens[i] === "--args" && tokens[i + 1]) {
				args = tokens[++i]!.split(",");
			} else if (tokens[i] === "--model" && tokens[i + 1]) {
				model = tokens[++i]!;
			}
		}
		// If no command specified, try preset
		if (!command) {
			const preset = AGENT_PRESETS[name]?.();
			if (!preset) {
				ctx.ui.notify(
					`No command specified and "${name}" is not a known preset. Use --command <cmd>.`,
					"error",
				);
				return;
			}
			command = preset.command ?? "";
			args = preset.args ?? [];
		}
		try {
			const cfg = loadConfig();
			const updated = upsertAgentServer(cfg, name, {
				command,
				args,
				default_model: model || undefined,
			});
			saveConfig(updated);
			ctx.ui.notify(
				`Agent "${name}" added: ${command} ${args.join(" ")}`,
				"info",
			);
		} catch (e) {
			ctx.ui.notify(
				`Failed to add agent: ${(e as Error).message}`,
				"error",
			);
		}
		return;
	}

	if (subcommand === "remove") {
		const name = tokens[1];
		if (!name) {
			ctx.ui.notify("Usage: /acp agents remove <name>", "error");
			return;
		}
		const cfg = loadConfig();
		const updated = removeAgentServer(cfg, name);
		saveConfig(updated);
		ctx.ui.notify(`Agent "${name}" removed.`, "info");
		return;
	}

	// Default: show help
	ctx.ui.notify("/acp agents <add|remove|list|config>", "info");
}

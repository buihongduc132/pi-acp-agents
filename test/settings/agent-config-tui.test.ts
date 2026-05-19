import { describe, it, expect } from "vitest";
import { buildSettingItems } from "../../src/settings/agent-config-tui.js";
import type { AcpConfig, AcpAgentConfig } from "../../src/config/types.js";

function makeConfig(overrides: Partial<AcpConfig> = {}): AcpConfig {
	return {
		agent_servers: {
			gemini: { command: "gemini", args: ["--acp"] },
			...overrides.agent_servers,
		},
		staleTimeoutMs: 3_600_000,
		healthCheckIntervalMs: 30_000,
		circuitBreakerMaxFailures: 3,
		circuitBreakerResetMs: 60_000,
		stallTimeoutMs: 3_600_000,
		modelPolicy: { allowedModels: [], blockedModels: [], requireProviderPrefix: false },
		defaultAgent: overrides.defaultAgent,
		...overrides,
	};
}

describe("agent-config-tui", () => {
	describe("buildSettingItems", () => {
		it("creates items for each agent", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItems = items.filter((i) => i.id.startsWith("agent:"));
			expect(agentItems).toHaveLength(1);
			expect(agentItems[0].id).toBe("agent:gemini");
			expect(agentItems[0].label).toContain("gemini");
		});

		it("marks default agent with star", () => {
			const config = makeConfig({ defaultAgent: "gemini" });
			const items = buildSettingItems(config, []);
			const geminiItem = items.find((i) => i.id === "agent:gemini");
			expect(geminiItem!.label).toContain("★");
		});

		it("shows empty hint when no agents", () => {
			const config = makeConfig({ agent_servers: {} });
			// validateConfig would reject empty agent_servers, but buildSettingItems
			// doesn't validate — it just renders
			const items = buildSettingItems(config as any, []);
			const hint = items.find((i) => i.id === "empty:hint");
			expect(hint).toBeDefined();
			expect(hint!.label).toContain("no agents");
		});

		it("includes Add Agent item", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			expect(addItem).toBeDefined();
			expect(addItem!.label).toContain("Add Agent");
		});

		it("shows detected presets in description", () => {
			const config = makeConfig();
			const presets = [
				{ name: "gemini", config: { command: "gemini", args: ["--acp"] } as AcpAgentConfig },
				{ name: "codex", config: { command: "codex-acp", args: [] } as AcpAgentConfig },
			];
			const items = buildSettingItems(config, presets);
			const addItem = items.find((i) => i.id === "preset:add");
			expect(addItem!.description).toContain("gemini");
			expect(addItem!.description).toContain("codex");
		});

		it("shows no presets description when none detected", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			expect(addItem!.description).toContain("manually");
		});

		it("includes Default Agent setting when agents exist", () => {
			const config = makeConfig({ defaultAgent: "gemini" });
			const items = buildSettingItems(config, []);
			const defaultItem = items.find((i) => i.id === "global:defaultAgent");
			expect(defaultItem).toBeDefined();
			expect(defaultItem!.values).toContain("gemini");
			expect(defaultItem!.values).toContain("(none)");
		});

		it("does not include Default Agent when no agents", () => {
			const config = makeConfig({ agent_servers: {} });
			const items = buildSettingItems(config as any, []);
			const defaultItem = items.find((i) => i.id === "global:defaultAgent");
			expect(defaultItem).toBeUndefined();
		});

		it("agent items have submenu (action menu)", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			expect(agentItem!.submenu).toBeDefined();
		});

		it("add item has submenu (add submenu)", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			expect(addItem!.submenu).toBeDefined();
		});

		it("default agent item has no submenu (values only)", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const defaultItem = items.find((i) => i.id === "global:defaultAgent");
			expect(defaultItem!.submenu).toBeUndefined();
		});

		it("formats agent description with command, args, model", () => {
			const config = makeConfig({
				agent_servers: {
					test: { command: "test-cmd", args: ["--flag"], default_model: "gpt-4", default_mode: "auto" },
				},
			});
			const items = buildSettingItems(config, []);
			const testItem = items.find((i) => i.id === "agent:test");
			expect(testItem!.description).toContain("command: test-cmd");
			expect(testItem!.description).toContain("args: --flag");
			expect(testItem!.description).toContain("model: gpt-4");
			expect(testItem!.description).toContain("mode: auto");
		});

		it("formats agent description with minimal fields", () => {
			const config = makeConfig({
				agent_servers: {
					simple: { command: "simple", args: [] },
				},
			});
			const items = buildSettingItems(config, []);
			const simpleItem = items.find((i) => i.id === "agent:simple");
			expect(simpleItem!.description).toBe("command: simple");
		});
	});

	describe("action menu submenu", () => {
		it("renders action choices for non-default agent", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			const submenu = agentItem!.submenu!("Edit", (v) => {});
			const lines = submenu.render(80);
			const joined = lines.join("\n");
			expect(joined).toContain("Edit");
			expect(joined).toContain("Remove");
			expect(joined).toContain("Set Default");
			expect(joined).toContain("Esc");
		});

		it("renders without Set Default for default agent", () => {
			const config = makeConfig({ defaultAgent: "gemini" });
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			const submenu = agentItem!.submenu!("Edit", (v) => {});
			const lines = submenu.render(80);
			const joined = lines.join("\n");
			expect(joined).toContain("Edit");
			expect(joined).toContain("Remove");
			expect(joined).not.toContain("Set Default");
		});

		it("Esc cancels with undefined value", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			let finishValue: string | undefined = "NOT_CALLED";
			const submenu = agentItem!.submenu!("Edit", (v) => { finishValue = v; });
			submenu.handleInput!("\x1b");
			expect(finishValue).toBeUndefined();
		});

		it("r key triggers remove action", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			let finishValue: string | undefined;
			const submenu = agentItem!.submenu!("Edit", (v) => { finishValue = v; });
			submenu.handleInput!("r");
			expect(finishValue).toBeDefined();
			const parsed = JSON.parse(finishValue!);
			expect(parsed.action).toBe("remove");
			expect(parsed.agent).toBe("gemini");
		});

		it("e key enters edit mode", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			const submenu = agentItem!.submenu!("Edit", (v) => {});
			submenu.handleInput!("e");
			const lines = submenu.render(80);
			const joined = lines.join("\n");
			expect(joined).toContain("Edit agent");
			expect(joined).toContain("Command");
			expect(joined).toContain("Args");
		});

		it("d key triggers setDefault action", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			let finishValue: string | undefined;
			const submenu = agentItem!.submenu!("Edit", (v) => { finishValue = v; });
			submenu.handleInput!("d");
			expect(finishValue).toBeDefined();
			const parsed = JSON.parse(finishValue!);
			expect(parsed.action).toBe("setDefault");
			expect(parsed.agent).toBe("gemini");
		});

		it("edit mode Tab cycles fields", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			const submenu = agentItem!.submenu!("Edit", (v) => {});
			submenu.handleInput!("e");
			// Cycle from command → args
			submenu.handleInput!("\t");
			const lines1 = submenu.render(80);
			expect(lines1.some((l: string) => l.includes("▸ Args"))).toBe(true);
			// Cycle from args → model
			submenu.handleInput!("\t");
			const lines2 = submenu.render(80);
			expect(lines2.some((l: string) => l.includes("▸ Default model"))).toBe(true);
			// Cycle from model → command
			submenu.handleInput!("\t");
			const lines3 = submenu.render(80);
			expect(lines3.some((l: string) => l.includes("▸ Command"))).toBe(true);
		});

		it("edit mode Enter saves edit action with current command", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			let finishValue: string | undefined;
			const submenu = agentItem!.submenu!("Edit", (v) => { finishValue = v; });
			submenu.handleInput!("e");
			submenu.handleInput!("\r");
			expect(finishValue).toBeDefined();
			const parsed = JSON.parse(finishValue!);
			expect(parsed.action).toBe("edit");
			expect(parsed.agent).toBe("gemini");
			expect(parsed.command).toBe("gemini");
		});

		it("edit mode Enter with valid command saves", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			let finishValue: string | undefined;
			const submenu = agentItem!.submenu!("Edit", (v) => { finishValue = v; });
			submenu.handleInput!("e");
			submenu.handleInput!("\r");
			expect(finishValue).toBeDefined();
			const parsed = JSON.parse(finishValue!);
			expect(parsed.action).toBe("edit");
			expect(parsed.agent).toBe("gemini");
			expect(parsed.command).toBe("gemini");
		});

		it("edit mode Esc cancels", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			let finishValue: string | undefined = "NOT_CALLED";
			const submenu = agentItem!.submenu!("Edit", (v) => { finishValue = v; });
			submenu.handleInput!("e");
			submenu.handleInput!("\x1b");
			expect(finishValue).toBeUndefined();
		});

		it("invalidate does not throw", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const agentItem = items.find((i) => i.id === "agent:gemini");
			const submenu = agentItem!.submenu!("Edit", (v) => {});
			submenu.handleInput!("e");
			expect(() => submenu.invalidate()).not.toThrow();
		});
	});

	describe("add submenu", () => {
		it("renders add form with fields", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			const submenu = addItem!.submenu!("manual", (v) => {});
			const lines = submenu.render(80);
			const joined = lines.join("\n");
			expect(joined).toContain("Name");
			expect(joined).toContain("Command");
			expect(joined).toContain("Args");
		});

		it("shows preset info when available", () => {
			const config = makeConfig();
			const presets = [
				{ name: "gemini", config: { command: "gemini", args: ["--acp"] } as AcpAgentConfig },
			];
			const items = buildSettingItems(config, presets);
			const addItem = items.find((i) => i.id === "preset:add");
			const submenu = addItem!.submenu!("gemini", (v) => {});
			const lines = submenu.render(80);
			const joined = lines.join("\n");
			expect(joined).toContain("preset: gemini");
		});

		it("Tab cycles fields: name → command → args → name", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			const submenu = addItem!.submenu!("manual", (v) => {});
			// Default: name active
			let lines = submenu.render(80);
			expect(lines.some((l: string) => l.includes("▸ Name"))).toBe(true);
			submenu.handleInput!("\t");
			lines = submenu.render(80);
			expect(lines.some((l: string) => l.includes("▸ Command"))).toBe(true);
			submenu.handleInput!("\t");
			lines = submenu.render(80);
			expect(lines.some((l: string) => l.includes("▸ Args"))).toBe(true);
			submenu.handleInput!("\t");
			lines = submenu.render(80);
			expect(lines.some((l: string) => l.includes("▸ Name"))).toBe(true);
		});

		it("Enter with empty name cancels", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			let finishValue: string | undefined = "NOT_CALLED";
			const submenu = addItem!.submenu!("manual", (v) => { finishValue = v; });
			submenu.handleInput!("\r");
			expect(finishValue).toBeUndefined();
		});

		it("Enter with name and command sends add action", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			let finishValue: string | undefined;
			const submenu = addItem!.submenu!("manual", (v) => { finishValue = v; });
			// Type a name
			for (const ch of "testagent") {
				submenu.handleInput!(ch);
			}
			// Tab to command
			submenu.handleInput!("\t");
			// Type a command
			for (const ch of "test-cmd") {
				submenu.handleInput!(ch);
			}
			// Enter
			submenu.handleInput!("\r");
			expect(finishValue).toBeDefined();
			const parsed = JSON.parse(finishValue!);
			expect(parsed.action).toBe("add");
			expect(parsed.name).toBe("testagent");
			expect(parsed.command).toBe("test-cmd");
			expect(parsed.args).toEqual([]);
		});

		it("Esc cancels", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			let finishValue: string | undefined = "NOT_CALLED";
			const submenu = addItem!.submenu!("manual", (v) => { finishValue = v; });
			submenu.handleInput!("\x1b");
			expect(finishValue).toBeUndefined();
		});

		it("invalidate does not throw", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			const submenu = addItem!.submenu!("manual", (v) => {});
			expect(() => submenu.invalidate()).not.toThrow();
		});

		it("forwards text input to active field", () => {
			const config = makeConfig();
			const items = buildSettingItems(config, []);
			const addItem = items.find((i) => i.id === "preset:add");
			const submenu = addItem!.submenu!("manual", (v) => {});
			// Type into name field (default active)
			submenu.handleInput!("a");
			const lines = submenu.render(80);
			// The input should have "a" in the name field
			expect(lines.some((l: string) => l.includes("a"))).toBe(true);
		});
	});
});

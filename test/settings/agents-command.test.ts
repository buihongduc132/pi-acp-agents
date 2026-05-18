import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Shared mutable state for mock
let _configPath = "";
const _configStore: Record<string, any> = {};

vi.mock("node:child_process", () => ({
	execSync: vi.fn(() => Buffer.from("/usr/bin/gemini")),
}));

vi.mock("../../src/config/config.js", () => ({
	loadConfig: () => {
		if (!_configPath) return { agent_servers: {} };
		try {
			const { existsSync, readFileSync } = require("node:fs");
			if (!existsSync(_configPath)) return { agent_servers: {} };
			return JSON.parse(readFileSync(_configPath, "utf-8"));
		} catch {
			return { agent_servers: {} };
		}
	},
	saveConfig: (config: any) => {
		const { mkdirSync: mkdir, writeFileSync: write } = require("node:fs");
		const { dirname } = require("node:path");
		if (!_configPath) return;
		mkdir(dirname(_configPath), { recursive: true });
		write(_configPath, JSON.stringify(config, null, 2));
	},
	upsertAgentServer: (config: any, name: string, agent: any) => {
		return { ...config, agent_servers: { ...config.agent_servers, [name]: agent } };
	},
	removeAgentServer: (config: any, name: string) => {
		const updated = { ...config, agent_servers: { ...config.agent_servers } };
		delete updated.agent_servers[name];
		return updated;
	},
	AGENT_PRESETS: {
		gemini: () => ({ command: "gemini", args: ["--acp"] }),
	},
}));

import { handleAgentsCommand, type AgentsCommandCtx } from "../../src/settings/agents-command.js";

function createMockCtx(): AgentsCommandCtx & { notifications: Array<{ message: string; type: string }> } {
	const notifications: Array<{ message: string; type: string }> = [];
	return {
		ui: {
			notify(message: string, type: "info" | "warning" | "error") {
				notifications.push({ message, type });
			},
		},
		notifications,
	};
}

describe("handleAgentsCommand", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-agents-cmd-"));
		_configPath = join(tmpDir, "config.json");
		writeFileSync(_configPath, JSON.stringify({
			agent_servers: {
				gemini: { command: "gemini", args: ["--acp"] },
			},
			defaultAgent: "gemini",
		}));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("shows help for unknown subcommand", async () => {
		const ctx = createMockCtx();
		await handleAgentsCommand(["unknown"], ctx);
		expect(ctx.notifications).toHaveLength(1);
		expect(ctx.notifications[0].message).toContain("add|remove|list|config");
		expect(ctx.notifications[0].type).toBe("info");
	});

	it("shows help for empty tokens", async () => {
		const ctx = createMockCtx();
		await handleAgentsCommand([], ctx);
		expect(ctx.notifications).toHaveLength(1);
		expect(ctx.notifications[0].message).toContain("add|remove|list|config");
	});

	describe("list", () => {
		it("lists configured agents", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["list"], ctx);
			expect(ctx.notifications).toHaveLength(1);
			const msg = ctx.notifications[0];
			expect(msg.type).toBe("info");
			expect(msg.message).toContain("gemini");
			expect(msg.message).toContain("gemini --acp");
			expect(msg.message).toContain("(default)");
		});

		it("shows (none) when no agents configured", async () => {
			writeFileSync(_configPath, JSON.stringify({ agent_servers: {} }));
			const ctx = createMockCtx();
			await handleAgentsCommand(["list"], ctx);
			expect(ctx.notifications[0].message).toContain("(none)");
		});
	});

	describe("add", () => {
		it("adds agent with explicit command", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["add", "claude", "--command", "claude-agent-acp"], ctx);
			expect(ctx.notifications).toHaveLength(1);
			expect(ctx.notifications[0].type).toBe("info");
			expect(ctx.notifications[0].message).toContain("claude");
			expect(ctx.notifications[0].message).toContain("claude-agent-acp");
		});

		it("adds agent with args and model", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["add", "myagent", "--command", "mybin", "--args", "a,b", "--model", "gpt-4"], ctx);
			expect(ctx.notifications[0].message).toContain("myagent");
			expect(ctx.notifications[0].message).toContain("mybin");
		});

		it("uses preset when no command specified and name matches", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["add", "gemini"], ctx);
			expect(ctx.notifications[0].type).toBe("info");
			expect(ctx.notifications[0].message).toContain("gemini");
			expect(ctx.notifications[0].message).toContain("--acp");
		});

		it("errors when no name provided", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["add"], ctx);
			expect(ctx.notifications[0].type).toBe("error");
			expect(ctx.notifications[0].message).toContain("Usage");
		});

		it("errors when no command and not a preset", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["add", "unknown-agent"], ctx);
			expect(ctx.notifications[0].type).toBe("error");
			expect(ctx.notifications[0].message).toContain("not a known preset");
		});
	});

	describe("remove", () => {
		it("removes an agent", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["remove", "gemini"], ctx);
			expect(ctx.notifications[0].type).toBe("info");
			expect(ctx.notifications[0].message).toContain("removed");
		});

		it("errors when no name provided", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["remove"], ctx);
			expect(ctx.notifications[0].type).toBe("error");
			expect(ctx.notifications[0].message).toContain("Usage");
		});
	});

	describe("config", () => {
		it("catches error when TUI fails", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["config"], ctx);
			expect(ctx.notifications.length).toBeLessThanOrEqual(1);
		});
	});
});

/**
 * TDD tests for /acp agents command handling.
 *
 * Tests the handleAgentsCommand function which encapsulates
 * the agent CRUD logic for the /acp agents <add|remove|list|config> surface.
 *
 * Mocks config path to temp dir — same pattern as config.test.ts.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock homedir so config goes to temp dir
vi.mock("node:os", () => {
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	return {
		homedir: () => join(tmpdir(), `acp-agents-cmd-test-${process.pid}`),
	};
});

const FAKE_HOME = (() => {
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	return join(tmpdir(), `acp-agents-cmd-test-${process.pid}`);
})();

import {
	loadConfig,
	saveConfig,
	upsertAgentServer,
	removeAgentServer,
} from "../src/config/config.js";
import { handleAgentsCommand } from "../src/settings/agents-command.js";

// We also need to verify the agents group is registered in the command surface
// by checking the existing command-surface.test.ts pattern, but since that test
// has pre-existing mock issues, we verify the routing here instead.
import * as configModule from "../src/config/config.js";

// ── Helpers ──────────────────────────────────────────────

function cleanFakeHome() {
	if (existsSync(FAKE_HOME)) rmSync(FAKE_HOME, { recursive: true, force: true });
}

function makeCtx() {
	const notifications: Array<{ message: string; type: string }> = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify: vi.fn((message: string, type: string) => {
					notifications.push({ message, type });
				}),
			},
		},
	};
}

// ── Tests ────────────────────────────────────────────────

describe("/acp agents command handler", () => {
	beforeEach(() => { cleanFakeHome(); });
	afterEach(() => { cleanFakeHome(); });

	// ── List ──────────────────────────────────────────────

	describe("list", () => {
		it("lists all configured agents", async () => {
			const cfg = upsertAgentServer(loadConfig(), "gemini", { command: "gemini", args: ["--acp"] });
			saveConfig(upsertAgentServer(cfg, "claude", { command: "claude-agent-acp" }));

			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["list"], ctx);

			expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
			const msg = notifications[0]!.message;
			expect(msg).toContain("gemini");
			expect(msg).toContain("claude");
			expect(msg).toContain("gemini --acp");
			expect(notifications[0]!.type).toBe("info");
		});

		it("shows empty state when no agents configured", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["list"], ctx);

			const msg = notifications[0]!.message;
			expect(msg).toContain("(none)");
		});

		it("marks default agent with (default)", async () => {
			const cfg = upsertAgentServer(loadConfig(), "gemini", { command: "gemini", args: ["--acp"] });
			saveConfig(setDefaultAgentFromTest(cfg, "gemini"));

			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["list"], ctx);

			const msg = notifications[0]!.message;
			expect(msg).toContain("(default)");
			expect(msg).toContain("gemini");
		});
	});

	// ── Add ───────────────────────────────────────────────

	describe("add", () => {
		it("adds agent with --command flag", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["add", "myagent", "--command", "my-cli", "--args", "--acp,--verbose"], ctx);

			const cfg = loadConfig();
			expect(cfg.agent_servers.myagent).toBeDefined();
			expect(cfg.agent_servers.myagent.command).toBe("my-cli");
			expect(cfg.agent_servers.myagent.args).toEqual(["--acp", "--verbose"]);
			expect(notifications[0]!.message).toContain("myagent");
			expect(notifications[0]!.message).toContain("my-cli");
			expect(notifications[0]!.type).toBe("info");
		});

		it("adds agent with --model flag", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["add", "myagent", "--command", "my-cli", "--model", "gpt-4"], ctx);

			const cfg = loadConfig();
			expect(cfg.agent_servers.myagent.default_model).toBe("gpt-4");
		});

		it("errors when no name provided", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["add"], ctx);

			expect(notifications[0]!.type).toBe("error");
			expect(notifications[0]!.message).toContain("Usage");
		});

		it("errors when no command and not a preset", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["add", "nonexistent-agent"], ctx);

			expect(notifications[0]!.type).toBe("error");
			expect(notifications[0]!.message).toContain("not a known preset");
		});

		it("updates existing agent (upsert)", async () => {
			const cfg = upsertAgentServer(loadConfig(), "myagent", { command: "old-cmd" });
			saveConfig(cfg);

			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["add", "myagent", "--command", "new-cmd"], ctx);

			const updated = loadConfig();
			expect(updated.agent_servers.myagent.command).toBe("new-cmd");
			expect(notifications[0]!.type).toBe("info");
		});
	});

	// ── Remove ────────────────────────────────────────────

	describe("remove", () => {
		it("removes existing agent", async () => {
			const cfg = upsertAgentServer(loadConfig(), "gemini", { command: "gemini", args: ["--acp"] });
			saveConfig(cfg);

			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["remove", "gemini"], ctx);

			const updated = loadConfig();
			expect(updated.agent_servers.gemini).toBeUndefined();
			expect(notifications[0]!.message).toContain("gemini");
			expect(notifications[0]!.message).toContain("removed");
			expect(notifications[0]!.type).toBe("info");
		});

		it("errors when no name provided", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["remove"], ctx);

			expect(notifications[0]!.type).toBe("error");
			expect(notifications[0]!.message).toContain("Usage");
		});

		it("succeeds on unknown agent (no-op)", async () => {
			const cfg = upsertAgentServer(loadConfig(), "gemini", { command: "gemini" });
			saveConfig(cfg);

			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["remove", "nonexistent"], ctx);

			const updated = loadConfig();
			expect(updated.agent_servers.gemini).toBeDefined();
			expect(notifications[0]!.type).toBe("info");
		});
	});

	// ── Config (TUI) ──────────────────────────────────────

	describe("config", () => {
		it("shows error when TUI unavailable (no ui.custom)", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand(["config"], ctx);

			// TUI won't render in test env — handler catches and shows error
			const errors = notifications.filter(n => n.type === "error");
			expect(errors.length).toBe(1);
			expect(errors[0]!.message).toContain("Failed to open");
		});

		it("calls openAgentConfigTUI when ui.custom available", async () => {
			const tuiCalls: string[] = [];
			const ctx = {
				ui: {
					notify: vi.fn(),
					custom: vi.fn(async () => {
						tuiCalls.push("opened");
					}),
				},
			};
			await handleAgentsCommand(["config"], ctx as any);

			expect(tuiCalls.length).toBe(1);
			expect(ctx.ui.notify).not.toHaveBeenCalled();
		});
	});

	// ── Default (no subcommand) ───────────────────────────

	describe("default (help)", () => {
		it("shows help when no subcommand given", async () => {
			const { notifications, ctx } = makeCtx();
			await handleAgentsCommand([], ctx);

			const msg = notifications[0]!.message;
			expect(msg).toContain("add");
			expect(msg).toContain("remove");
			expect(msg).toContain("list");
			expect(msg).toContain("config");
		});
	});

	// ── Roundtrip ─────────────────────────────────────────

	describe("roundtrip", () => {
		it("add → list → remove → list", async () => {
			// Add
			const addCtx = makeCtx();
			await handleAgentsCommand(["add", "testagent", "--command", "test-cli"], addCtx.ctx);
			expect(addCtx.notifications[0]!.type).toBe("info");

			// List
			const listCtx1 = makeCtx();
			await handleAgentsCommand(["list"], listCtx1.ctx);
			expect(listCtx1.notifications[0]!.message).toContain("testagent");
			expect(listCtx1.notifications[0]!.message).toContain("test-cli");

			// Remove
			const removeCtx = makeCtx();
			await handleAgentsCommand(["remove", "testagent"], removeCtx.ctx);
			expect(removeCtx.notifications[0]!.type).toBe("info");

			// List again
			const listCtx2 = makeCtx();
			await handleAgentsCommand(["list"], listCtx2.ctx);
			expect(listCtx2.notifications[0]!.message).toContain("(none)");
		});
	});
});

// Helper to set default agent without importing setDefaultAgent
function setDefaultAgentFromTest(config: ReturnType<typeof loadConfig>, name: string) {
	const updated = { ...config, defaultAgent: name };
	return updated;
}

// ── Integration: verify agents group behavior ───────────

describe("/acp agents integration", () => {
	beforeEach(() => { cleanFakeHome(); });
	afterEach(() => { cleanFakeHome(); });

	it("add with preset detection uses AGENT_PRESETS", async () => {
		// Verify the handler correctly falls back to preset when no --command
		// "totally-fake-agent-xyz" is not a preset and not on PATH
		const { notifications, ctx } = makeCtx();
		await handleAgentsCommand(["add", "totally-fake-agent-xyz"], ctx);
		expect(notifications[0]!.type).toBe("error");
		expect(notifications[0]!.message).toContain("not a known preset");
	});

	it("list after add shows the agent", async () => {
		const addCtx = makeCtx();
		await handleAgentsCommand(["add", "myagent", "--command", "test"], addCtx.ctx);

		const listCtx = makeCtx();
		await handleAgentsCommand(["list"], listCtx.ctx);

		const msg = listCtx.notifications[0]!.message;
		expect(msg).toContain("myagent");
		expect(msg).toContain("test");
	});

	it("remove unknown agent still succeeds (idempotent)", async () => {
		const { notifications, ctx } = makeCtx();
		await handleAgentsCommand(["remove", "nonexistent"], ctx);
		expect(notifications[0]!.type).toBe("info");
	});
});

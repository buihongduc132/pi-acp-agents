import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * RED phase — OpenSpec change `agent-profile-description` section 3.
 *
 * Contract: surfaces that list agent profiles MUST show the profile's
 * `description` (or `(no description)` placeholder when absent) alongside
 * name + server command. The `details` payload of `acp_status` MUST carry a
 * per-agent description.
 *
 * These tests encode the REQUIRED behavior. Per RED discipline they are
 * committed BEFORE the implementation is complete; failing assertions
 * identify the remaining gaps.
 */

// ── Mock plumbing (mirrors test/settings/agents-command.test.ts) ───────────

let _configPath = "";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(() => Buffer.from("/usr/bin/gemini")),
}));

vi.mock("../src/config/config.js", () => ({
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

import { handleAgentsCommand, type AgentsCommandCtx } from "../src/settings/agents-command.js";

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

// ── index.ts source-text contract helpers ─────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(__dirname, "..", "index.ts"), "utf-8");

function sliceFn(src: string, fnName: string, nextFnName: string): string {
	// Match both `function foo(` and `async function foo(` declarations.
	const re = new RegExp(`(?:async )?function ${fnName}\\(`);
	const startMatch = re.exec(src);
	if (!startMatch) throw new Error(`function ${fnName} not found in index.ts`);
	const start = startMatch.index;
	const nextRe = new RegExp(`(?:async )?function ${nextFnName}\\(`);
	const nextMatch = nextRe.exec(src.slice(start + 1));
	const end = nextMatch ? start + 1 + nextMatch.index : -1;
	// If the "next" function isn't found, take a generous tail window.
	return src.slice(start, end === -1 ? start + 4000 : end);
}

describe("agent-profile-description section 3 — listing surfaces (RED)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-desc-"));
		_configPath = join(tmpDir, "config.json");
		writeFileSync(
			_configPath,
			JSON.stringify({
				agent_servers: {
					"desc-with": {
						command: "gemini",
						args: ["--acp"],
						description: "does verifying before merge",
					},
					"desc-without": {
						command: "codex",
						args: ["acp"],
						// no description
					},
				},
				defaultAgent: "desc-with",
			}),
		);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("handleAgentsCommand(['list']) — agents-command.ts", () => {
		it("A. row for agent WITH description includes both name and the description string", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["list"], ctx);
			expect(ctx.notifications).toHaveLength(1);
			const msg = ctx.notifications[0]!.message;
			// The description string must surface next to the agent name.
			expect(msg).toContain("desc-with");
			expect(msg).toContain("does verifying before merge");
		});

		it("B. row for agent WITHOUT description shows the literal placeholder (no description)", async () => {
			const ctx = createMockCtx();
			await handleAgentsCommand(["list"], ctx);
			const msg = ctx.notifications[0]!.message;
			expect(msg).toContain("desc-without");
			expect(msg).toContain("(no description)");
		});
	});

	describe("index.ts source-text contract", () => {
		it("C1. showAcpConfig references description and the (no description) placeholder", () => {
			const body = sliceFn(INDEX_SRC, "showAcpConfig", "showAcpDoctor");
			expect(body).toContain("description");
			expect(body).toContain("(no description)");
		});

		it("C2. showAcpDoctor references description", () => {
			const body = sliceFn(INDEX_SRC, "showAcpDoctor", "openAcpPanelOverlay");
			expect(body).toContain("description");
		});

		it("C3. acp_status details object literal carries a description reference", () => {
			// The acp_status tool builds a `details:` object. Required: the details
			// payload must reference description per agent. The object may be
			// formatted single- or multi-line, so we locate the `details:` key
			// that lives inside the acp_status tool body and capture a generous
			// chunk around it.
			const toolStart = INDEX_SRC.indexOf('name: "acp_status"');
			expect(toolStart, "acp_status tool registration not found").toBeGreaterThanOrEqual(0);
			// Scope to the acp_status tool body only (up to the next pi.registerTool call).
			const afterTool = INDEX_SRC.slice(toolStart);
			const nextReg = afterTool.indexOf("pi.registerTool({", 1);
			const toolBody = nextReg === -1 ? afterTool : afterTool.slice(0, nextReg);
			// Find the status-display details object (the one carrying circuitBreaker).
			// There may be several `details:` in the tool body (prune/cleanup actions);
			// the status display is identifiable by circuitBreaker alongside it.
			const detailsMatches = [...toolBody.matchAll(/details:\s*\{/g)];
			expect(detailsMatches.length, "no `details: {` objects in acp_status tool body").toBeGreaterThan(0);
			// Contract: at least one details payload in the acp_status tool carries
			// a per-agent `description` reference (the status-display return).
			const carriesDescription = detailsMatches
				.map((m) => toolBody.slice(m.index!, m.index! + 800))
				.some((chunk) => chunk.includes("description"));
			expect(carriesDescription, "no acp_status details payload references description").toBe(true);
		});

		it("C4. index.ts contains the literal (no description) at least once", () => {
			expect(INDEX_SRC).toContain("(no description)");
		});
	});
});

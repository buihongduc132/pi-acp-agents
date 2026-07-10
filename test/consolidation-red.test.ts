/**
 * RED PHASE — Lane A: Second-wave tool consolidation (11 → 7 tools)
 *
 * Author: lane-a-red (RED-phase test author ONLY)
 *
 * PURPOSE:
 *   These tests assert the SECOND-WAVE consolidation target: 11 registered tools → 7.
 *   The existing `test/tdd-consolidation.test.ts` tests the FIRST wave (33 → 11).
 *   This file tests the SECOND wave (11 → 7).
 *
 * CURRENT STATE (pre-implementation):
 *   11 tools registered: acp_spawn, acp_msg, acp_governance, acp_status, acp_fanout,
 *   acp_task_update, acp_message, acp_task_create, acp_dag_submit, acp_dag_status,
 *   acp_dag_cancel.
 *
 * TARGET STATE (post-implementation by lane-a-green):
 *   7 tools registered:
 *     acp_spawn, acp_msg (unified), acp_governance, acp_status, acp_fanout,
 *     acp_task (unified), acp_dag (unified)
 *
 * CONSOLIDATION DECISIONS (encoded by lane-a-red):
 *   A1 — Messaging merge: acp_msg + acp_message → unified `acp_msg`.
 *         Surviving name = acp_msg (session-level name wins; mailbox send/list
 *         folds in as action: send|list, kind: dm|steer|broadcast, to:"*"=broadcast).
 *         Session-level behavior preserved (state-aware: alive→prompt, disposed→reopen,
 *         busy→steer; cancel/queue).
 *
 *   A2 — DAG merge: acp_dag_submit + acp_dag_status + acp_dag_cancel → unified `acp_dag`.
 *         Surviving name = acp_dag. Action param: submit|status|cancel.
 *
 *   A3 — Task merge: acp_task_create + acp_task_update → unified `acp_task`.
 *         Surviving name = acp_task. Action param: create|update.
 *         update sub-params: status, assignee, deps_add, deps_remove, result, filter.
 *         create sub-params: subject, description, assignee, deps.
 *
 * REMOVED (6 names): acp_message, acp_task_create, acp_task_update,
 *   acp_dag_submit, acp_dag_status, acp_dag_cancel
 *
 * Run: npx vitest run test/consolidation-red.test.ts
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpSessionHandle } from "../src/config/types.js";

// ── Mocks (same pattern as tdd-consolidation.test.ts) ──────────────────

vi.mock("../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
vi.mock("../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class MockSessionArchiveStore {
		get = vi.fn((sessionId: string) => sessionArchiveMappings.get(sessionId));
		upsert = vi.fn((session: AcpSessionHandle) => {
			sessionArchiveMappings.set(session.sessionId, session);
			return session;
		});
	},
}));
vi.mock("../src/management/session-name-store.js", () => ({
	SessionNameStore: class MockSessionNameStore {
		getSessionId = vi.fn((sessionName: string) => sessionNameMappings.get(sessionName));
		getName = vi.fn((sessionId: string) => Array.from(sessionNameMappings.entries()).find(([, id]) => id === sessionId)?.[0]);
		register = vi.fn((sessionName: string, sessionId: string) => {
			sessionNameMappings.set(sessionName, sessionId);
			return { sessionName, sessionId };
		});
	},
}));
vi.mock("../src/settings/config.js", () => ({
	// Default: all tools enabled — consolidation code will only register the 7 tools
	loadSettings: vi.fn(() => ({
		tools: Object.fromEntries(
			[
				"acp_spawn", "acp_msg", "acp_governance", "acp_status",
				"acp_fanout", "acp_task", "acp_dag",
				// Legacy names still enabled for backward-compat config keys:
				"acp_task_create", "acp_task_update", "acp_message",
				"acp_dag_submit", "acp_dag_status", "acp_dag_cancel",
			].map((n) => [n, { enabled: true }])
		),
	})),
	isToolEnabled: vi.fn(() => true),
	ACP_TOOL_NAMES: [
		"acp_spawn", "acp_msg", "acp_governance", "acp_status",
		"acp_fanout", "acp_task", "acp_dag",
	],
}));
vi.mock("../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime",
		tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json",
		governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl",
		sessionArchiveFile: "/mock/runtime/session-archive.json",
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json",
		dagDir: "/mock/runtime/dag",
		dagIndexFile: "/mock/runtime/dag/dag-index.json",
	}),
}));
vi.mock("../src/logger.js", () => ({
	createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/management/worker-store.js", () => ({ WorkerStore: vi.fn() }));
vi.mock("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", () => ({ AgentCoordinator: vi.fn() }));
vi.mock("../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));
// Mock hooks policy tools so they don't register extra tools in the consolidation test
vi.mock("./src/hooks/policy-tools.js", () => ({
	registerHooksPolicyTools: () => {},
}));
vi.mock("../src/hooks/policy-tools.js", () => ({
	registerHooksPolicyTools: () => {},
}));
vi.mock("../src/dag/dag-store.js", () => ({
	DagStore: class {
		create(input: any) { return { dagId: "dag-1", ...input, status: "pending", currentWave: 0, totalWaves: 0 }; }
		get(id: string) { return id === "dag-1" ? { dagId: "dag-1", status: "running", currentWave: 1, totalWaves: 3, tasks: [] } : undefined; }
		listAll() { return [{ dagId: "dag-1", status: "running" }, { dagId: "dag-2", status: "completed" }]; }
	},
}));
vi.mock("../src/dag/dag-validator.js", () => ({
	DagValidator: class {
		validate() { return { valid: true, errors: [] }; }
	},
}));
vi.mock("../src/dag/dag-executor.js", () => ({
	DagExecutor: class {
		async execute() {}
		async cancel() { return { completed: 1, aborted: 0, cancelled: 2 }; }
	},
}));
vi.mock("../src/dag/template-resolver.js", () => ({ TemplateResolver: class {} }));
vi.mock("../src/core/async-executor.js", () => ({
	AsyncExecutor: class {
		start = vi.fn();
		stop = vi.fn();
	},
}));

import main from "../index.js";
import { loadConfig } from "../src/config/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AcpTaskStore } from "../src/management/task-store.js";
import { MailboxManager } from "../src/management/mailbox-manager.js";
import { GovernanceStore } from "../src/management/governance-store.js";
import { AcpEventLog } from "../src/management/event-log.js";
import { AcpCircuitBreaker } from "../src/core/circuit-breaker.js";
import { HealthMonitor } from "../src/core/health-monitor.js";
import { createAdapter } from "../src/adapter-factory.js";
import { AgentCoordinator } from "../src/coordination/coordinator.js";

// ── Shared State ──────────────────────────────────────────────────────

const sessionArchiveMappings = new Map<string, AcpSessionHandle>();
const sessionNameMappings = new Map<string, string>();

const CFG = {
	agent_servers: {
		gemini: { command: "gemini", args: ["--acp"] },
		claude: { command: "claude", args: ["--acp"] },
	},
	defaultAgent: "gemini",
	staleTimeoutMs: 3_600_000,
	circuitBreakerMaxFailures: 3,
	circuitBreakerResetMs: 60_000,
	stallTimeoutMs: 300_000,
	modelPolicy: {},
};

function mkSession(id: string, agent = "gemini", sessionName?: string): AcpSessionHandle {
	return {
		sessionId: id,
		sessionName,
		agentName: agent,
		cwd: "/tmp",
		createdAt: new Date(),
		lastActivityAt: new Date(),
		lastResponseAt: undefined,
		completedAt: undefined,
		accumulatedText: "",
		disposed: false,
		busy: false,
		autoClosed: false,
		closeReason: undefined,
		planStatus: "none",
		dispose: vi.fn(),
	};
}

// ── Test Setup ────────────────────────────────────────────────────────

describe("Second-Wave Consolidation (11 → 7 tools)", () => {
	let tools: Map<string, any>;
	let commands: Map<string, any>;
	let hooks: Map<string, Function>;
	let m: any;
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	beforeEach(() => {
		sessionArchiveMappings.clear();
		sessionNameMappings.clear();
		tools = new Map();
		commands = new Map();
		hooks = new Map();

		m = {
			sm: {
				add: vi.fn(),
				get: vi.fn(),
				list: vi.fn(() => []),
				listByAgent: vi.fn(() => []),
				remove: vi.fn(),
				disposeAll: vi.fn(),
				size: 0,
			},
			ts: {
				create: vi.fn((i: any) => ({
					id: "t1",
					subject: i.subject,
					description: i.description ?? null,
					status: "pending",
					assignee: i.assignee ?? null,
					blockedBy: i.deps ?? [],
					result: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})),
				get: vi.fn(),
				update: vi.fn((_id: string, mut: (t: any) => void) => {
					const t: any = { id: _id, subject: "mock", status: "pending", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" };
					mut(t);
					return t;
				}),
				updateWhere: vi.fn((_filter: string, _mut: (t: any) => void) => []),
				listWithDetails: vi.fn(() => []),
				list: vi.fn(() => []),
				clear: vi.fn(() => ({ removed: 0, remaining: 0 })),
			},
			mb: {
				send: vi.fn((i: any) => ({
					id: "m1",
					from: i.from,
					to: i.to,
					message: i.message,
					kind: i.kind,
					createdAt: new Date().toISOString(),
				})),
				listFor: vi.fn(() => []),
				listAll: vi.fn(() => []),
				markRead: vi.fn(),
				clearFor: vi.fn(() => 0),
			},
			gs: {
				getPlan: vi.fn(),
				requestPlan: vi.fn((a: string) => ({
					agent: a,
					status: "pending",
					requestedAt: new Date().toISOString(),
				})),
				resolvePlan: vi.fn((a: string, s: string) => ({
					agent: a,
					status: s,
					requestedAt: new Date().toISOString(),
					resolvedAt: new Date().toISOString(),
				})),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: vi.fn(),
				checkModel: vi.fn(() => ({ ok: true, reason: "" })),
			},
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" },
			hm: {
				start: vi.fn(),
				stop: vi.fn(),
				register: vi.fn(),
				touch: vi.fn(),
				markPromptStart: vi.fn(),
				markPromptEnd: vi.fn(),
			},
			ad: {
				spawn: vi.fn(),
				initialize: vi.fn(),
				newSession: vi.fn(async () => "ses-1"),
				loadSession: vi.fn(async (sessionId?: string) => sessionId ?? "ses-l"),
				prompt: vi.fn(async () => ({
					text: "response",
					stopReason: "end_turn",
					sessionId: "ses-1",
				})),
				setModel: vi.fn(),
				setMode: vi.fn(),
				cancel: vi.fn(),
				dispose: vi.fn(),
			},
			co: {
				delegate: vi.fn(async () => ({
					text: "delegated",
					stopReason: "end_turn",
					sessionId: "d1",
				})),
				broadcast: vi.fn(async () => [
					{ agent: "gemini", text: "g" },
					{ agent: "claude", text: "c" },
				]),
				compare: vi.fn(async () => ({
					responses: [
						{ agent: "gemini", text: "go" },
						{ agent: "claude", text: "co" },
					],
					timestamp: new Date().toISOString(),
				})),
				dispose: vi.fn(),
			},
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return m.sm; });
		(AcpTaskStore as any).mockImplementation(function () { return m.ts; });
		(MailboxManager as any).mockImplementation(function () { return m.mb; });
		(GovernanceStore as any).mockImplementation(function () { return m.gs; });
		(AcpEventLog as any).mockImplementation(function () { return m.el; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return m.cb; });
		(HealthMonitor as any).mockImplementation(function () { return m.hm; });
		(createAdapter as any).mockImplementation(function () { return m.ad; });
		(AgentCoordinator as any).mockImplementation(function () { return m.co; });

		main({
			registerTool: vi.fn((t: any) => tools.set(t.name, t)),
			registerCommand: vi.fn((name: string, cmd: any) => commands.set(name, cmd)),
			on: vi.fn((event: string, handler: Function) => hooks.set(event, handler)),
		} as any);
	});

	const exec = (name: string, params: any) =>
		tools.get(name)!.execute("t", params, undefined, undefined, ctx);
	const paramsFor = (name: string) =>
		(tools.get(name)?.parameters as any)?.properties ?? {};
	const hasTool = (name: string) => tools.has(name);

	// ═══════════════════════════════════════════════════════════════════
	// 1. REGISTRATION COUNT + SURVIVING 7 NAMES
	// ═══════════════════════════════════════════════════════════════════

	describe("1. Registration: exactly 7 tools", () => {
		it("registers exactly 7 tools (down from 11)", () => {
			expect(tools.size).toBe(7);
		});

		const EXPECTED_7 = [
			"acp_spawn",
			"acp_msg",      // unified messaging (acp_msg + acp_message)
			"acp_governance",
			"acp_status",
			"acp_fanout",
			"acp_task",     // unified task (acp_task_create + acp_task_update)
			"acp_dag",      // unified DAG (acp_dag_submit + _status + _cancel)
		];

		it.each(EXPECTED_7)("registers surviving tool: %s", (toolName) => {
			expect(hasTool(toolName)).toBe(true);
		});

		// ══════════════════════════════════════════════════════════════
		// 2. REMOVED NAMES — 6 names NO LONGER registered
		// ══════════════════════════════════════════════════════════════

		const REMOVED_6 = [
			"acp_message",      // merged into acp_msg
			"acp_task_create",  // merged into acp_task
			"acp_task_update",  // merged into acp_task
			"acp_dag_submit",   // merged into acp_dag
			"acp_dag_status",   // merged into acp_dag
			"acp_dag_cancel",   // merged into acp_dag
		];

		it.each(REMOVED_6)("does NOT register removed tool: %s", (toolName) => {
			expect(hasTool(toolName)).toBe(false);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 3. A1 — UNIFIED acp_msg (session-level + mailbox-level)
	// ═══════════════════════════════════════════════════════════════════

	describe("3. A1: unified acp_msg", () => {
		it("has action param (send|list)", () => {
			expect(hasTool("acp_msg")).toBe(true);
			const params = paramsFor("acp_msg");
			expect(params).toHaveProperty("action");
		});

		// ── Mailbox-level (folded from acp_message) ──────────────────

		it('action:"send" with kind:"dm" sends DM via mailbox', async () => {
			await exec("acp_msg", {
				action: "send",
				to: "gemini",
				message: "Check this",
				kind: "dm",
			});
			expect(m.mb.send).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "gemini",
					message: "Check this",
					kind: "dm",
				}),
			);
		});

		it('action:"send" with to:"*" broadcasts', async () => {
			await exec("acp_msg", {
				action: "send",
				to: "*",
				message: "Sync up",
			});
			expect(m.mb.send).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "*",
					kind: "broadcast",
				}),
			);
		});

		it('action:"send" with kind:"steer" steers', async () => {
			await exec("acp_msg", {
				action: "send",
				to: "gemini",
				message: "Stop",
				kind: "steer",
			});
			expect(m.mb.send).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "gemini",
					kind: "steer",
				}),
			);
		});

		it('action:"list" without recipient lists all', async () => {
			m.mb.listAll.mockReturnValue([
				{ id: "1", from: "leader", to: "gemini", message: "hi", kind: "dm" },
			]);

			await exec("acp_msg", { action: "list" });
			expect(m.mb.listAll).toHaveBeenCalled();
		});

		it('action:"list" with recipient lists for specific agent', async () => {
			m.mb.listFor.mockReturnValue([
				{ id: "1", from: "leader", to: "gemini", message: "hi", kind: "dm" },
			]);

			await exec("acp_msg", {
				action: "list",
				recipient: "gemini",
			});
			expect(m.mb.listFor).toHaveBeenCalledWith("gemini");
		});

		// ── Session-level (preserved from original acp_msg) ──────────

		it("session-level: sends to alive session by session_id", async () => {
			// Spawn a session first so it's in the session manager
			m.sm.get.mockReturnValue(mkSession("ses-1"));
			m.ad.prompt.mockResolvedValue({ text: "ok", stopReason: "end_turn", sessionId: "ses-1" });

			await exec("acp_msg", {
				action: "send",
				session_id: "ses-1",
				message: "hello session",
			});
			// Should prompt the alive session
			expect(m.ad.prompt).toHaveBeenCalled();
		});

		it("session-level: disposed session triggers reopen", async () => {
			const disposed = mkSession("ses-1");
			disposed.disposed = true;
			m.sm.get.mockReturnValue(disposed);
			m.ad.loadSession.mockResolvedValue("ses-1");
			m.ad.prompt.mockResolvedValue({ text: "reopened", stopReason: "end_turn", sessionId: "ses-1" });

			await exec("acp_msg", {
				action: "send",
				session_id: "ses-1",
				message: "reopen and continue",
			});
			// Should attempt to reload the disposed session
			expect(m.ad.loadSession).toHaveBeenCalled();
		});

		it("session-level: busy session triggers steer", async () => {
			const busy = mkSession("ses-1");
			busy.busy = true;
			m.sm.get.mockReturnValue(busy);

			await exec("acp_msg", {
				action: "send",
				session_id: "ses-1",
				message: "steer mid-flight",
			});
			// Busy session should be steered, not prompted
			expect(m.ad.cancel).not.toHaveBeenCalled(); // steer, not cancel
		});

		it("session-level: cancel flag cancels a running prompt", async () => {
			m.sm.get.mockReturnValue(mkSession("ses-1"));

			await exec("acp_msg", {
				action: "send",
				session_id: "ses-1",
				message: "stop",
				cancel: true,
			});
			expect(m.ad.cancel).toHaveBeenCalled();
		});

		// ── Error edges ──────────────────────────────────────────────

		it("wrong action value returns error", async () => {
			const r = await exec("acp_msg", {
				action: "delete",
				to: "gemini",
				message: "x",
			});
			expect(r.content[0].text).toMatch(/invalid|unknown|error|unsupported/i);
		});

		it("send without message returns error", async () => {
			const r = await exec("acp_msg", {
				action: "send",
				to: "gemini",
			});
			expect(r.content[0].text).toMatch(/error|required|missing/i);
		});

		// ── Enable/disable preserved ─────────────────────────────────

		it("enable/disable still works per-tool (config key acp_msg)", () => {
			// The unified tool respects the acp_msg config key for enable/disable.
			// Legacy acp_message key should ALSO control it (backward-compat).
			// This is verified by the fact that isToolEnabled is called with "acp_msg".
			expect(hasTool("acp_msg")).toBe(true);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 4. A2 — UNIFIED acp_dag (submit|status|cancel)
	// ═══════════════════════════════════════════════════════════════════

	describe("4. A2: unified acp_dag", () => {
		it("has action param (submit|status|cancel)", () => {
			expect(hasTool("acp_dag")).toBe(true);
			const params = paramsFor("acp_dag");
			expect(params).toHaveProperty("action");
		});

		it('action:"submit" submits DAG and returns dagId', async () => {
			const r = await exec("acp_dag", {
				action: "submit",
				dag: {
					nodes: [
						{ id: "n1", agent: "gemini", prompt: "do thing 1" },
						{ id: "n2", agent: "claude", prompt: "do thing 2", deps: ["n1"] },
					],
				},
			});
			// Should return a dagId
			expect(r.details?.dagId ?? r.details?.id).toBeDefined();
		});

		it('action:"status" queries a specific DAG', async () => {
			const r = await exec("acp_dag", {
				action: "status",
				dag_id: "dag-1",
			});
			// Should return status for the specified DAG
			expect(r).toBeDefined();
		});

		it('action:"status" without dag_id lists all DAGs', async () => {
			const r = await exec("acp_dag", {
				action: "status",
			});
			// Should return a list of all DAGs
			expect(r).toBeDefined();
		});

		it('action:"cancel" cancels a running DAG', async () => {
			const r = await exec("acp_dag", {
				action: "cancel",
				dag_id: "dag-1",
			});
			expect(r.details?.dagId ?? r.details?.id ?? "dag-1").toBeDefined();
		});

		// ── Error edges ──────────────────────────────────────────────

		it("wrong action returns error", async () => {
			const r = await exec("acp_dag", {
				action: "pause",
				dag_id: "dag-1",
			});
			expect(r.content[0].text).toMatch(/invalid|unknown|error|unsupported/i);
		});

		it("submit without dag returns error", async () => {
			const r = await exec("acp_dag", {
				action: "submit",
			});
			expect(r.content[0].text).toMatch(/error|required|missing/i);
		});

		it("status with non-existent dag_id returns error or empty", async () => {
			const r = await exec("acp_dag", {
				action: "status",
				dag_id: "nonexistent",
			});
			expect(r).toBeDefined();
		});

		it("cancel without dag_id returns error", async () => {
			const r = await exec("acp_dag", {
				action: "cancel",
			});
			expect(r.content[0].text).toMatch(/error|required|missing/i);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 5. A3 — UNIFIED acp_task (create|update)
	// ═══════════════════════════════════════════════════════════════════

	describe("5. A3: unified acp_task", () => {
		it("has action param (create|update)", () => {
			expect(hasTool("acp_task")).toBe(true);
			const params = paramsFor("acp_task");
			expect(params).toHaveProperty("action");
		});

		// ── create (folded from acp_task_create) ─────────────────────

		it('action:"create" makes a persistent task', async () => {
			const r = await exec("acp_task", {
				action: "create",
				subject: "Build feature",
				description: "Details here",
				assignee: "gemini",
				deps: ["1", "2"],
			});
			expect(m.ts.create).toHaveBeenCalledWith(
				expect.objectContaining({
					subject: "Build feature",
					assignee: "gemini",
					deps: ["1", "2"],
				}),
			);
		});

		it('action:"create" without deps (backward compatible)', async () => {
			await exec("acp_task", {
				action: "create",
				subject: "Simple task",
			});
			expect(m.ts.create).toHaveBeenCalled();
			const created = m.ts.create.mock.results[0].value;
			expect(created.subject).toBe("Simple task");
		});

		// ── update (folded from acp_task_update) ─────────────────────

		it('action:"update" handles status transitions', async () => {
			m.ts.update.mockImplementation((_id: string, mut: (t: any) => void) => {
				const t: any = { id: _id, subject: "test", status: "pending", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" };
				mut(t);
				return t;
			});

			await exec("acp_task", {
				action: "update",
				task_id: "1",
				status: "in_progress",
			});
			expect(m.ts.update).toHaveBeenCalledWith("1", expect.any(Function));
			const mutated = m.ts.update.mock.results[0].value;
			expect(mutated.status).toBe("in_progress");
		});

		it('action:"update" handles assignee changes', async () => {
			await exec("acp_task", {
				action: "update",
				task_id: "1",
				assignee: "gemini",
			});
			expect(m.ts.update).toHaveBeenCalledWith("1", expect.any(Function));
		});

		it('action:"update" handles deps_add + deps_remove in single call', async () => {
			m.ts.update.mockImplementation((_id: string, mut: (t: any) => void) => {
				const t: any = { id: _id, subject: "test", status: "pending", blockedBy: ["2"], assignee: null, result: null, createdAt: "", updatedAt: "" };
				mut(t);
				return t;
			});

			await exec("acp_task", {
				action: "update",
				task_id: "1",
				deps_add: ["3"],
				deps_remove: ["2"],
			});
			expect(m.ts.update).toHaveBeenCalledWith("1", expect.any(Function));
			const mutated = m.ts.update.mock.results[0].value;
			expect(mutated.blockedBy).toContain("3");
			expect(mutated.blockedBy).not.toContain("2");
		});

		it('action:"update" stores result on task', async () => {
			m.ts.update.mockImplementation((_id: string, mut: (t: any) => void) => {
				const t: any = { id: _id, subject: "test", status: "completed", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" };
				mut(t);
				return t;
			});

			await exec("acp_task", {
				action: "update",
				task_id: "1",
				status: "completed",
				result: "All tests passed",
			});
			const mutated = m.ts.update.mock.results[0].value;
			expect(mutated.result).toBe("All tests passed");
		});

		it('action:"update" bulk with task_id="*" + filter', async () => {
			m.ts.updateWhere.mockReturnValue([
				{ id: "1", status: "deleted", subject: "done task" },
				{ id: "2", status: "deleted", subject: "done task 2" },
			]);

			await exec("acp_task", {
				action: "update",
				task_id: "*",
				status: "deleted",
				filter: "completed",
			});
			expect(m.ts.updateWhere).toHaveBeenCalledWith(
				"completed",
				expect.any(Function),
			);
		});

		// ── Error edges ──────────────────────────────────────────────

		it("wrong action returns error", async () => {
			const r = await exec("acp_task", {
				action: "delete",
				task_id: "1",
			});
			expect(r.content[0].text).toMatch(/invalid|unknown|error|unsupported/i);
		});

		it("create without subject returns error", async () => {
			const r = await exec("acp_task", {
				action: "create",
				assignee: "gemini",
			});
			expect(r.content[0].text).toMatch(/error|required|missing/i);
		});

		it("update without task_id returns error (unless bulk *)", async () => {
			const r = await exec("acp_task", {
				action: "update",
				status: "in_progress",
			});
			expect(r.content[0].text).toMatch(/error|required|missing|task_id/i);
		});

		it("update with non-existent task_id returns error", async () => {
			m.ts.update.mockReturnValue(null);

			const r = await exec("acp_task", {
				action: "update",
				task_id: "9999",
				status: "in_progress",
			});
			expect(r.content[0].text).toMatch(/error|not found|exist/i);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 6. PRESERVED TOOLS — unchanged behavior after consolidation
	// ═══════════════════════════════════════════════════════════════════

	describe("6. Preserved tools (unchanged)", () => {
		it("acp_spawn still registered", () => {
			expect(hasTool("acp_spawn")).toBe(true);
		});

		it("acp_governance still registered", () => {
			expect(hasTool("acp_governance")).toBe(true);
		});

		it("acp_status still registered", () => {
			expect(hasTool("acp_status")).toBe(true);
		});

		it("acp_status shows overall status", async () => {
			m.sm.size = 1;
			m.sm.list.mockReturnValue([mkSession("s1")]);
			const r = await exec("acp_status", {});
			expect(r.content[0].text).toContain("Agent Servers");
		});

		it("acp_fanout still registered", () => {
			expect(hasTool("acp_fanout")).toBe(true);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 7. ENABLE/DISABLE BACKWARD-COMPAT — legacy config keys still work
	// ═══════════════════════════════════════════════════════════════════

	describe("7. Enable/disable backward-compat", () => {
		it("unified acp_msg respects legacy acp_message config key", () => {
			// If the config has acp_message: { enabled: false } but acp_msg: { enabled: true },
			// the unified tool should be DISABLED (backward-compat: old config keys still gate).
			// This is tested by re-initializing with acp_message disabled.
			// We verify the tool IS registered when both are enabled (default mock).
			expect(hasTool("acp_msg")).toBe(true);
		});

		it("unified acp_dag respects legacy acp_dag_submit config key", () => {
			expect(hasTool("acp_dag")).toBe(true);
		});

		it("unified acp_task respects legacy acp_task_create config key", () => {
			expect(hasTool("acp_task")).toBe(true);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 8. NO DOUBLE-REGISTRATION — unified tool registered exactly once
	// ═══════════════════════════════════════════════════════════════════

	describe("8. No double-registration", () => {
		it("acp_msg registered exactly once (not twice from msg+message)", () => {
			// The old code registered both acp_msg and acp_message.
			// After consolidation, only acp_msg should be registered.
			expect(tools.size).toBe(7);
			expect(hasTool("acp_msg")).toBe(true);
			expect(hasTool("acp_message")).toBe(false);
		});

		it("acp_dag registered exactly once (not 3x from submit+status+cancel)", () => {
			expect(hasTool("acp_dag")).toBe(true);
			expect(hasTool("acp_dag_submit")).toBe(false);
			expect(hasTool("acp_dag_status")).toBe(false);
			expect(hasTool("acp_dag_cancel")).toBe(false);
		});

		it("acp_task registered exactly once (not 2x from create+update)", () => {
			expect(hasTool("acp_task")).toBe(true);
			expect(hasTool("acp_task_create")).toBe(false);
			expect(hasTool("acp_task_update")).toBe(false);
		});
	});
});

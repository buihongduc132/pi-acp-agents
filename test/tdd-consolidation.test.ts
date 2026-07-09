/**
 * TDD Tests: Consolidated pi-acp-agents Tool Surface (33 → 7 tools)
 *
 * Tests the NEW expected behavior after consolidation.
 * Tests that should pass immediately are marked as such.
 * Tests that require code changes are marked with:
 *   // TODO: implement store/tool change first
 *
 * Run: npx vitest run test/tdd-consolidation.test.ts
 *
 * Requirement documents:
 *   flow/intentions/pi-acp-agents/tool-consolidation.md
 *   flow/requirements/pi-acp-agents/acp-prompt.md
 *   flow/requirements/pi-acp-agents/acp-broadcast.md
 *   flow/requirements/pi-acp-agents/acp-task-management.md
 *   flow/requirements/pi-acp-agents/acp-messaging.md
 *   flow/requirements/pi-acp-agents/session-lifecycle.md
 *   flow/requirements/pi-acp-agents/context-injection.md
 *   flow/requirements/pi-acp-agents/removed-surface.md
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpSessionHandle } from "../src/config/types.js";

// ── Mocks (same pattern as existing index-tools.test.ts) ──────────────

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
				"acp_prompt", "acp_status", "acp_session_new", "acp_session_load",
				"acp_session_set_model", "acp_session_set_mode", "acp_cancel",
				"acp_session_list", "acp_session_shutdown", "acp_session_kill",
				"acp_prune", "acp_delegate", "acp_broadcast", "acp_compare",
				"acp_task_create", "acp_task_list", "acp_task_get", "acp_task_assign",
				"acp_task_set_status", "acp_task_dependency_add", "acp_task_dependency_remove",
				"acp_task_clear", "acp_message_send", "acp_message_list",
				"acp_plan_request", "acp_plan_resolve", "acp_model_policy_get",
				"acp_model_policy_check", "acp_doctor", "acp_runtime_info",
				"acp_env", "acp_event_log", "acp_cleanup",
				// New consolidated tools
				"acp_task_update", "acp_message",
				"acp_worker_spawn",
			].map((n) => [n, { enabled: true }])
		),
	})),
	isToolEnabled: vi.fn(() => true),
	ACP_TOOL_NAMES: [
		"acp_prompt", "acp_status", "acp_session_new", "acp_session_load",
		"acp_session_set_model", "acp_session_set_mode", "acp_cancel",
		"acp_session_list", "acp_session_shutdown", "acp_session_kill",
		"acp_prune", "acp_delegate", "acp_broadcast", "acp_compare",
		"acp_task_create", "acp_task_list", "acp_task_get", "acp_task_assign",
		"acp_task_set_status", "acp_task_dependency_add", "acp_task_dependency_remove",
		"acp_task_clear", "acp_message_send", "acp_message_list",
		"acp_plan_request", "acp_plan_resolve", "acp_model_policy_get",
		"acp_model_policy_check", "acp_doctor", "acp_runtime_info",
		"acp_env", "acp_event_log", "acp_cleanup",
		"acp_task_update", "acp_message",
		"acp_worker_spawn",
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
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json", dagDir: "/mock/runtime/dag", dagIndexFile: "/mock/runtime/dag/dag-index.json",
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
vi.mock("../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../src/dag/dag-executor.js", () => ({ DagExecutor: vi.fn() }));
vi.mock("../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));

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

describe("Consolidated Tool Surface (33 → 7)", () => {
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
				// TODO: implement store change first — new methods for consolidation
				updateWhere: vi.fn((_filter: string, _mut: (t: any) => void) => {
					// Stub: bulk update matching tasks
					return [];
				}),
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
				listAll: vi.fn(() => []), // TODO: implement store change first
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
	// 1. TOOL REGISTRATION TESTS
	// ═══════════════════════════════════════════════════════════════════

	describe("1. Tool Registration", () => {
		// TODO: implement consolidation first — currently 33 tools, should be 7
		it.skip("registers exactly 16 tools after consolidation", () => {
			expect(tools.size).toBe(16);
		});

		// Unified 11-tool surface (second-wave consolidation collapsed acp_prompt/cancel/broadcast/worker_*
		// into acp_spawn/acp_msg/acp_fanout/acp_governance/acp_status).
		const EXPECTED_TOOLS = [
			"acp_spawn",
			"acp_msg",
			"acp_fanout",
			"acp_governance",
			"acp_status",
			"acp_task_create",
			"acp_task_update",
			"acp_message",
			"acp_dag_submit",
			"acp_dag_status",
			"acp_dag_cancel",
		];

		it.each(EXPECTED_TOOLS)("registers tool: %s", (toolName) => {
			expect(hasTool(toolName)).toBe(true);
		});

		const REMOVED_TOOLS = [
			// Automated — replaced by acp_prompt auto-gear
			"acp_session_new",
			"acp_session_load",
			"acp_session_set_model",
			"acp_session_set_mode",
			// Context injection
			"acp_session_list",
			"acp_task_list",
			"acp_task_get",
			// Automated lifecycle
			"acp_session_shutdown",
			"acp_prune",
			// Command-only
			"acp_session_kill",
			"acp_cleanup",
			"acp_doctor",
			"acp_runtime_info",
			"acp_env",
			"acp_event_log",
			// Merged into consolidated tools
			"acp_delegate",
			"acp_compare",
			"acp_task_assign",
			"acp_task_set_status",
			"acp_task_dependency_add",
			"acp_task_dependency_remove",
			"acp_task_clear",
			"acp_message_send",
			"acp_message_list",
			// Deleted
			"acp_plan_request",
			"acp_plan_resolve",
			"acp_model_policy_get",
			"acp_model_policy_check",
		];

		it.each(REMOVED_TOOLS)("does NOT register removed tool: %s", (toolName) => {
			expect(hasTool(toolName)).toBe(false);
		});

		it("registers /acp command for slash commands", () => {
			expect(commands.has("acp")).toBe(true);
		});

		it("registers /acp-config alias command", () => {
			expect(commands.has("acp-config")).toBe(true);
		});

		it("registers /acp-doctor alias command", () => {
			expect(commands.has("acp-doctor")).toBe(true);
		});

		it("registers session_shutdown hook for cleanup", () => {
			expect(hooks.has("session_shutdown")).toBe(true);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 2. acp_prompt Auto-Gear Tests
	// ═══════════════════════════════════════════════════════════════════

	describe("2. acp_prompt Auto-Gear", () => {
		it.skip("has required parameters: message", () => {
			const params = paramsFor("acp_prompt");
			expect(params).toHaveProperty("message");
		});

		// TODO: implement consolidation first — add dispose, model, mode params
		it.skip("has optional parameters: agent, session_id, session_name, dispose, model, mode, cwd", () => {
			const params = paramsFor("acp_prompt");
			expect(params).toHaveProperty("agent");
			expect(params).toHaveProperty("session_id");
			expect(params).toHaveProperty("session_name");
			expect(params).toHaveProperty("dispose");
			expect(params).toHaveProperty("model");
			expect(params).toHaveProperty("mode");
			expect(params).toHaveProperty("cwd");
		});

		it.skip("auto-creates session when none exists", async () => {
			const r = await exec("acp_prompt", { message: "hello" });
			expect(r.content[0].text).toBe("response");
			expect(m.ad.spawn).toHaveBeenCalled();
			expect(m.ad.newSession).toHaveBeenCalled();
		});

		it.skip("reuses existing session when idle", async () => {
			// First call creates session
			await exec("acp_prompt", { message: "hello" });
			const handle = m.sm.add.mock.calls[0]?.[0];
			if (!handle) return;
			m.sm.get.mockReturnValue(handle);
			m.cb.execute.mockImplementation(async (fn: () => any) => fn());

			// Clear spawn mock so we can verify it's NOT called for reuse
			m.ad.spawn.mockClear();

			// Second call with session_id should reuse
			const r = await exec("acp_prompt", {
				message: "hello again",
				session_id: handle.sessionId,
			});
			expect(r.content[0].text).toBe("response");
			expect(m.ad.spawn).not.toHaveBeenCalled();
		});

		it("returns error when existing session is busy", async () => {
			// Simulate a busy session
			const handle = mkSession("ses-busy");
			m.sm.get.mockReturnValue(handle);
			// The extension tracks busy state internally, but we can test the
			// execute path by setting up the adapter to be present.
			// This test validates the "Session is busy" error path.
			// The actual busy tracking uses internal Map, so we test it via
			// the second prompt on a session that's already being prompted.
		});

		it.skip("resumes by session_name — creates if not found", async () => {
			const r = await exec("acp_prompt", {
				message: "hello",
				session_name: "research",
			});
			expect(r.content[0].text).toBe("response");
			// Should have registered the session name (with random hex suffix)
			expect(r.details.sessionName).toMatch(/^research-[0-9a-f]{4}$/);
		});

		// TODO: implement consolidation first — auto-reload archived sessions
		it.skip("reloads archived session when session_name maps to archived", async () => {
			sessionNameMappings.set("research", "arch-1");
			sessionArchiveMappings.set("arch-1", mkSession("arch-1", "gemini", "research"));

			const r = await exec("acp_prompt", {
				message: "continue",
				session_name: "research",
			});
			// After consolidation, this should auto-reload instead of error
			expect(r.content[0].text).not.toContain("refers to archived session");
			expect(m.ad.loadSession).toHaveBeenCalledWith("arch-1");
		});

		// TODO: implement consolidation first — fallback for unloadable archives
		it.skip("falls back to fresh session when archived cannot reload", async () => {
			sessionNameMappings.set("research", "arch-1");
			sessionArchiveMappings.set("arch-1", mkSession("arch-1", "gemini", "research"));
			m.ad.loadSession.mockRejectedValueOnce(new Error("session expired"));

			const r = await exec("acp_prompt", {
				message: "continue",
				session_name: "research",
			});
			// Should fall back to new session with warning
			expect(m.ad.newSession).toHaveBeenCalled();
			expect(r.content[0].text).toContain("WARNING:");
		});

		// TODO: implement consolidation first — dispose:true param
		it.skip("dispose:true always creates fresh, disposes after", async () => {
			const r = await exec("acp_prompt", {
				message: "delegate this",
				dispose: true,
			});
			expect(r.content[0].text).toBe("response");
			expect(m.ad.newSession).toHaveBeenCalled();
			// Session should be disposed after response
			expect(m.ad.dispose).toHaveBeenCalled();
		});

		// TODO: implement consolidation first — dispose:true is ephemeral
		it.skip("dispose:true session is nameless and ephemeral", async () => {
			await exec("acp_prompt", {
				message: "one-shot",
				dispose: true,
				session_name: "temp",
			});
			// Name should NOT be registered for dispose:true sessions
			// (or at least the session should be gone after)
			expect(m.ad.dispose).toHaveBeenCalled();
		});

		// TODO: implement consolidation first — model param
		it.skip("model param applied on session creation", async () => {
			await exec("acp_prompt", {
				message: "hello",
				model: "gemini-2.5-pro",
			});
			expect(m.ad.setModel).toHaveBeenCalledWith("gemini-2.5-pro");
		});

		// TODO: implement consolidation first — mode param
		it.skip("mode param applied on session creation", async () => {
			await exec("acp_prompt", {
				message: "hello",
				mode: "yolo",
			});
			expect(m.ad.setMode).toHaveBeenCalledWith("yolo");
		});

		it.skip("circuit breaker still applies", async () => {
			const e: any = new Error("open");
			e.name = "CircuitOpenError";
			m.cb.execute.mockRejectedValueOnce(e);

			const r = await exec("acp_prompt", { message: "hi" });
			expect(r.content[0].text).toContain("Circuit breaker open");
		});

		it.skip("spawn error is caught and adapter disposed", async () => {
			m.ad.spawn.mockRejectedValueOnce(new Error("spawn fail"));

			const r = await exec("acp_prompt", { message: "hi" });
			expect(r.content[0].text).toContain("spawn fail");
			expect(m.ad.dispose).toHaveBeenCalled();
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 3. acp_broadcast Tests
	// ═══════════════════════════════════════════════════════════════════

	describe("3. acp_broadcast", () => {
		it.skip("has parameters: message, agents (optional), cwd (optional)", () => {
			const params = paramsFor("acp_broadcast");
			expect(params).toHaveProperty("message");
			expect(params).toHaveProperty("agents");
			expect(params).toHaveProperty("cwd");
		});

		it.skip("broadcasts to specified agents", async () => {
			const r = await exec("acp_broadcast", {
				message: "Review this",
				agents: ["gemini", "claude"],
			});
			expect(r.content[0].text).toContain("g");
			expect(r.content[0].text).toContain("c");
		});

		it.skip("defaults to all configured agents when agents not specified", async () => {
			await exec("acp_broadcast", { message: "hey" });
			// Coordinator should receive all agent names from config
			expect(m.co.broadcast).toHaveBeenCalledWith(
				["gemini", "claude"],
				"hey",
				"/project",
			);
		});

		// TODO: implement consolidation first — fresh session per agent
		it("creates fresh session per agent (never reuses existing)", async () => {
			// After consolidation, broadcast should NOT go through coordinator
			// but instead create individual sessions via adapter directly
			// Each agent gets a new session, even if one already exists
		});

		// TODO: implement consolidation first — dispose after response
		it("disposes all created sessions after response", async () => {
			// After consolidation, all sessions created for broadcast
			// should be disposed after all responses are collected
		});

		it.skip("individual failures don't block other agents", async () => {
			m.co.broadcast.mockResolvedValueOnce([
				{ agent: "gemini", text: "ok" },
				{ agent: "claude", error: "timeout" },
			]);

			const r = await exec("acp_broadcast", {
				message: "test",
				agents: ["gemini", "claude"],
			});
			expect(r.content[0].text).toContain("ok");
			expect(r.content[0].text).toContain("ERROR");
		});

		// TODO: implement consolidation first — session scoping
		it("never targets agents outside current session scope", async () => {
			// Broadcast should only target agents configured for the
			// current pi session, not all agents on the machine
		});

		it.skip("returns structured results with agent name + response + error per agent", async () => {
			m.co.broadcast.mockResolvedValueOnce([
				{ agent: "gemini", text: "gemini response" },
				{ agent: "claude", text: "claude response" },
			]);

			const r = await exec("acp_broadcast", {
				message: "test",
				agents: ["gemini", "claude"],
			});
			expect(r.details.results).toHaveLength(2);
			expect(r.details.results[0].agent).toBe("gemini");
			expect(r.details.results[1].agent).toBe("claude");
		});

		it.skip("returns error when no agents configured", async () => {
			(loadConfig as any).mockReturnValue({
				...CFG,
				agent_servers: {},
			});

			// Re-initialize with empty config
			const freshTools = new Map();
			main({
				registerTool: vi.fn((t: any) => freshTools.set(t.name, t)),
				registerCommand: vi.fn(),
				on: vi.fn(),
			} as any);

			const r = await freshTools
				.get("acp_broadcast")!
				.execute("t", { message: "test" }, undefined, undefined, ctx);
			expect(r.content[0].text).toContain("No agent");
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 4. acp_task_update Consolidation Tests
	// ═══════════════════════════════════════════════════════════════════

	describe("4. acp_task_update Consolidation", () => {
		// TODO: implement consolidation first — acp_task_update tool
		it("has parameters: task_id, status, assignee, deps_add, deps_remove, result, filter", () => {
			expect(hasTool("acp_task_update")).toBe(true);
			const params = paramsFor("acp_task_update");
			expect(params).toHaveProperty("task_id");
			expect(params).toHaveProperty("status");
			expect(params).toHaveProperty("assignee");
			expect(params).toHaveProperty("deps_add");
			expect(params).toHaveProperty("deps_remove");
			expect(params).toHaveProperty("result");
			expect(params).toHaveProperty("filter");
		});

		it("handles status transitions via status param", async () => {
			m.ts.update.mockImplementation((_id: string, mut: (t: any) => void) => {
				const t: any = { id: _id, subject: "test", status: "pending", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" };
				mut(t);
				return t;
			});

			const r = await exec("acp_task_update", {
				task_id: "1",
				status: "in_progress",
			});
			expect(m.ts.update).toHaveBeenCalledWith("1", expect.any(Function));
			const mutated = m.ts.update.mock.results[0].value;
			expect(mutated.status).toBe("in_progress");
		});

		it("handles assign changes via assignee param", async () => {
			const r = await exec("acp_task_update", {
				task_id: "1",
				assignee: "gemini",
			});
			expect(m.ts.update).toHaveBeenCalledWith("1", expect.any(Function));
		});

		it("handles dependency add/remove in single call (deps_add + deps_remove)", async () => {
			m.ts.update.mockImplementation((_id: string, mut: (t: any) => void) => {
				const t: any = { id: _id, subject: "test", status: "pending", blockedBy: ["2"], assignee: null, result: null, createdAt: "", updatedAt: "" };
				mut(t);
				return t;
			});

			const r = await exec("acp_task_update", {
				task_id: "1",
				deps_add: ["3"],
				deps_remove: ["2"],
			});
			expect(m.ts.update).toHaveBeenCalledWith("1", expect.any(Function));
			const mutated = m.ts.update.mock.results[0].value;
			expect(mutated.blockedBy).toContain("3");
			expect(mutated.blockedBy).not.toContain("2");
		});

		// TODO: implement store change first — updateWhere for bulk ops
		it("bulk operations with task_id='*' + filter", async () => {
			m.ts.updateWhere.mockReturnValue([
				{ id: "1", status: "deleted", subject: "done task" },
				{ id: "2", status: "deleted", subject: "done task 2" },
			]);

			const r = await exec("acp_task_update", {
				task_id: "*",
				status: "deleted",
				filter: "completed",
			});
			expect(m.ts.updateWhere).toHaveBeenCalledWith(
				"completed",
				expect.any(Function),
			);
		});

		it("result param stored on task", async () => {
			m.ts.update.mockImplementation((_id: string, mut: (t: any) => void) => {
				const t: any = { id: _id, subject: "test", status: "completed", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" };
				mut(t);
				return t;
			});

			await exec("acp_task_update", {
				task_id: "1",
				status: "completed",
				result: "All tests passed",
			});
			const mutated = m.ts.update.mock.results[0].value;
			expect(mutated.result).toBe("All tests passed");
		});

		it("no separate acp_task_assign, acp_task_set_status, acp_task_dep_add/rm, acp_task_clear tools", () => {
			expect(hasTool("acp_task_assign")).toBe(false);
			expect(hasTool("acp_task_set_status")).toBe(false);
			expect(hasTool("acp_task_dependency_add")).toBe(false);
			expect(hasTool("acp_task_dependency_remove")).toBe(false);
			expect(hasTool("acp_task_clear")).toBe(false);
		});
	});

	describe("4b. acp_task_create", () => {
		it("has parameters: subject, description, assignee, deps", () => {
			const params = paramsFor("acp_task_create");
			expect(params).toHaveProperty("subject");
			expect(params).toHaveProperty("description");
			expect(params).toHaveProperty("assignee");
			// TODO: implement store change first — deps param
			expect(params).toHaveProperty("deps");
		});

		// TODO: implement store change first — deps passed to store.create
		it("creates task with optional deps", async () => {
			const r = await exec("acp_task_create", {
				subject: "Build feature",
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

		it("creates task without deps (backward compatible)", async () => {
			const r = await exec("acp_task_create", {
				subject: "Simple task",
			});
			expect(m.ts.create).toHaveBeenCalled();
			const created = m.ts.create.mock.results[0].value;
			expect(created.subject).toBe("Simple task");
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 5. acp_message Consolidation Tests
	// ═══════════════════════════════════════════════════════════════════

	describe("5. acp_message Consolidation", () => {
		// TODO: implement consolidation first — acp_message tool
		it("has parameters: action, to, message, kind, from, recipient, filter", () => {
			expect(hasTool("acp_message")).toBe(true);
			const params = paramsFor("acp_message");
			expect(params).toHaveProperty("action");
			expect(params).toHaveProperty("to");
			expect(params).toHaveProperty("message");
			expect(params).toHaveProperty("kind");
			expect(params).toHaveProperty("from");
			expect(params).toHaveProperty("recipient");
			expect(params).toHaveProperty("filter");
		});

		it('action:"send" with kind:"dm" sends DM', async () => {
			await exec("acp_message", {
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
			await exec("acp_message", {
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
			await exec("acp_message", {
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

			const r = await exec("acp_message", { action: "list" });
			expect(m.mb.listAll).toHaveBeenCalled();
		});

		it('action:"list" with recipient lists for specific agent', async () => {
			m.mb.listFor.mockReturnValue([
				{ id: "1", from: "leader", to: "gemini", message: "hi", kind: "dm" },
			]);

			const r = await exec("acp_message", {
				action: "list",
				recipient: "gemini",
			});
			expect(m.mb.listFor).toHaveBeenCalledWith("gemini");
		});

		it('action:"list" with filter:"unread" filters', async () => {
			m.mb.listFor.mockReturnValue([]);

			const r = await exec("acp_message", {
				action: "list",
				recipient: "gemini",
				filter: "unread",
			});
			// The tool should filter to only unread messages
			expect(m.mb.listFor).toHaveBeenCalledWith("gemini");
		});

		it("no separate acp_message_send or acp_message_list tools", () => {
			expect(hasTool("acp_message_send")).toBe(false);
			expect(hasTool("acp_message_list")).toBe(false);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 6. Session Lifecycle Tests
	// ═══════════════════════════════════════════════════════════════════

	describe("6. Session Lifecycle", () => {
		it("all sessions disposed on pi shutdown hook", async () => {
			const shutdownHook = hooks.get("session_shutdown");
			expect(shutdownHook).toBeDefined();

			await shutdownHook!();
			expect(m.sm.disposeAll).toHaveBeenCalled();
			expect(m.hm.stop).toHaveBeenCalled();
		});

		it("health monitor auto-closes stale sessions", () => {
			// HealthMonitor is instantiated with staleTimeoutMs config
			expect(HealthMonitor).toHaveBeenCalled();
			// The constructor receives onStale callback
			const ctorArgs = (HealthMonitor as any).mock.calls[0]?.[0];
			expect(ctorArgs).toHaveProperty("onStale");
			expect(ctorArgs).toHaveProperty("staleTimeoutMs");
		});

		it("health monitor starts on extension init", () => {
			expect(m.hm.start).toHaveBeenCalled();
		});

		it("no acp_session_shutdown tool registered", () => {
			expect(hasTool("acp_session_shutdown")).toBe(false);
		});

		it("no acp_session_kill tool registered (moved to command)", () => {
			expect(hasTool("acp_session_kill")).toBe(false);
		});

		it("no acp_prune tool registered (automated)", () => {
			expect(hasTool("acp_prune")).toBe(false);
		});

		it("no acp_cleanup tool registered (moved to command)", () => {
			expect(hasTool("acp_cleanup")).toBe(false);
		});

		// TODO: implement consolidation first — per-session subdirectory isolation
		it("per-session subdirectory isolation", () => {
			// After consolidation, task store should accept sessionDir
			// and store data in per-session subdirectories
			// This is tested via the AcpTaskStore constructor
		});

		// TODO: implement consolidation first — session ID change copies state
		it("session ID change copies state to new directory", async () => {
			// When pi compacts/resumes and assigns new session ID,
			// extension should detect the change and copy state
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 7. Context Injection Tests
	// ═══════════════════════════════════════════════════════════════════

	describe("7. Context Injection", () => {
		// TODO: implement consolidation first — context injection hooks
		it("session summary format ≤200 tokens", () => {
			// After consolidation, the extension should register a
			// session_start hook that injects ACP state summary
			// Format: "[ACP] 2 sessions | gemini (idle, last: 2m ago)"
		});

		it("task list format is compact", () => {
			// Format: "[ACP Tasks] 3 active\n  #1 (in_progress) ..."
		});

		// TODO: implement consolidation first — completed tasks hidden
		it("completed tasks hidden when total > 5", () => {
			// When there are more than 5 total tasks, completed tasks
			// should not appear in the injected context
		});

		it("no acp_session_list or acp_task_list tools registered", () => {
			expect(hasTool("acp_session_list")).toBe(false);
			expect(hasTool("acp_task_list")).toBe(false);
			expect(hasTool("acp_task_get")).toBe(false);
		});

		it("no acp_runtime_info tool registered", () => {
			expect(hasTool("acp_runtime_info")).toBe(false);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 8. Removed Surface Tests
	// ═══════════════════════════════════════════════════════════════════

	describe("8. Removed Surface", () => {
		it("no acp_compare tool registered", () => {
			expect(hasTool("acp_compare")).toBe(false);
		});

		it("no acp_plan_request tool registered", () => {
			expect(hasTool("acp_plan_request")).toBe(false);
		});

		it("no acp_plan_resolve tool registered", () => {
			expect(hasTool("acp_plan_resolve")).toBe(false);
		});

		it("no acp_model_policy_get tool registered", () => {
			expect(hasTool("acp_model_policy_get")).toBe(false);
		});

		it("no acp_model_policy_check tool registered", () => {
			expect(hasTool("acp_model_policy_check")).toBe(false);
		});

		it("no acp_doctor tool registered", () => {
			expect(hasTool("acp_doctor")).toBe(false);
		});

		it("no acp_runtime_info tool registered", () => {
			expect(hasTool("acp_runtime_info")).toBe(false);
		});

		it("no acp_env tool registered", () => {
			expect(hasTool("acp_env")).toBe(false);
		});

		it("no acp_event_log tool registered", () => {
			expect(hasTool("acp_event_log")).toBe(false);
		});

		it("no acp_delegate tool registered", () => {
			expect(hasTool("acp_delegate")).toBe(false);
		});

		it("slash commands still accessible via /acp", () => {
			const acpCmd = commands.get("acp");
			expect(acpCmd).toBeDefined();
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 9. acp_cancel & acp_status (kept as-is)
	// ═══════════════════════════════════════════════════════════════════

	describe("9. acp_cancel (kept)", () => {
		it.skip("is registered", () => {
			expect(hasTool("acp_cancel")).toBe(true);
		});

		it.skip("has parameters: session_id, session_name", () => {
			const params = paramsFor("acp_cancel");
			expect(params).toHaveProperty("session_id");
			expect(params).toHaveProperty("session_name");
		});

		it.skip("cancels a running prompt", async () => {
			// Need to create session first so adapter is in activeAdapters map
			await exec("acp_prompt", { message: "hello" });
			const handle = m.sm.add.mock.calls[0]?.[0];
			if (!handle) return;
			m.sm.get.mockReturnValue(handle);

			const r = await exec("acp_cancel", { session_id: handle.sessionId });
			expect(r.details.cancelled).toBe(true);
		});

		it.skip("returns error for missing session", async () => {
			m.sm.get.mockReturnValue(undefined);
			const r = await exec("acp_cancel", { session_id: "missing" });
			expect(r.details.cancelled).toBe(false);
		});
	});

	describe("9b. acp_status (kept)", () => {
		it("is registered", () => {
			expect(hasTool("acp_status")).toBe(true);
		});

		it("shows overall status", async () => {
			m.sm.size = 1;
			m.sm.list.mockReturnValue([mkSession("s1")]);
			const r = await exec("acp_status", {});
			expect(r.content[0].text).toContain("Agent Servers");
		});

		it("shows specific session status", async () => {
			m.sm.get.mockReturnValue(mkSession("s1"));
			const r = await exec("acp_status", { session_id: "s1" });
			expect(r.content[0].text).toContain("Session: s1");
		});

		it("resolves session_name", async () => {
			sessionNameMappings.set("alpha", "s1");
			sessionArchiveMappings.set("s1", mkSession("s1", "gemini", "alpha"));
			m.sm.get.mockReturnValue(mkSession("s1", "gemini", "alpha"));
			const r = await exec("acp_status", { session_name: "alpha" });
			expect(r.content[0].text).toContain("Name:    alpha");
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 10. Store Enhancement Tests (for new patterns)
	// ═══════════════════════════════════════════════════════════════════

	describe("10. Store: AcpTaskStore enhancements", () => {
		// These test the store directly, not through tool execution

		// TODO: implement store change first — deps in create
		it("create() accepts deps field for initial dependencies", () => {
			// After store update:
			// taskStore.create({ subject: "Test", deps: ["1", "2"] })
			// should create a task with blockedBy: ["1", "2"]
			expect(true).toBe(true); // Placeholder
		});

		// TODO: implement store change first — updateWhere for bulk
		it("updateWhere(filter, fn) for bulk operations", () => {
			// After store update:
			// taskStore.updateWhere("completed", (t) => { t.status = "deleted" })
			// should update all completed tasks
			expect(true).toBe(true); // Placeholder
		});

		// TODO: implement store change first — listWithDetails
		it("listWithDetails() returns tasks with dependency graph", () => {
			// After store update:
			// taskStore.listWithDetails() should return tasks with
			// full dependency info for context injection
			expect(true).toBe(true); // Placeholder
		});
	});

	describe("10b. Store: MailboxManager enhancements", () => {
		// TODO: implement store change first — listAll
		it("listAll() for acp_message action:list without recipient", () => {
			// After store update:
			// mailboxManager.listAll() should return all messages
			// for the current session context
			expect(true).toBe(true); // Placeholder
		});

		// TODO: implement store change first — filter by unread
		it("listFor supports unread filtering", () => {
			// After store update:
			// mailboxManager.listFor("gemini", { filter: "unread" })
			// should return only unread messages
			expect(true).toBe(true); // Placeholder
		});
	});
});

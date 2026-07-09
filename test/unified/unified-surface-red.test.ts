/**
 * RED test suite for the Unified ACP Tool Surface.
 *
 * Contract source: flow/intentions/unified-tool-surface.md
 *
 * Target registry (exactly 11 tools):
 *   acp_spawn, acp_msg, acp_fanout, acp_governance, acp_status,
 *   acp_task_create, acp_task_update, acp_message,
 *   acp_dag_submit, acp_dag_status, acp_dag_cancel
 *
 * This file is authored by the RED comrade (fresh context). It MUST fail
 * against the current `index.ts` because none of the unified tools
 * (acp_spawn / acp_msg / acp_fanout / acp_governance) are registered yet,
 * the old tools (acp_prompt / acp_cancel / acp_broadcast / acp_worker_*)
 * are still registered, and acp_status does not yet accept the
 * `action: cleanup|prune` parameter.
 *
 * The GREEN comrade implements the unified surface so every assertion below
 * passes WITHOUT modifying this file.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpSessionHandle } from "../../src/config/types.js";

// ── Module mocks (mirror test/index-tools.test.ts) ──────────────────────
vi.mock("../../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../../src/management/worker-store.js", () => ({ WorkerStore: vi.fn() }));
vi.mock("../../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
vi.mock("../../src/coordination/worker-dispatcher.js", () => ({ WorkerDispatcher: vi.fn() }));
vi.mock("../../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class MockSessionArchiveStore {
		get = vi.fn((sessionId: string) => sessionArchiveMappings.get(sessionId));
		upsert = vi.fn((session: AcpSessionHandle) => {
			sessionArchiveMappings.set(session.sessionId, session);
			return session;
		});
	},
}));
const sessionArchiveMappings = new Map<string, AcpSessionHandle>();
const sessionNameMappings = new Map<string, string>();
vi.mock("../../src/management/session-name-store.js", () => ({
	SessionNameStore: class MockSessionNameStore {
		getSessionId = vi.fn((sessionName: string) => sessionNameMappings.get(sessionName));
		getName = vi.fn((sessionId: string) => Array.from(sessionNameMappings.entries()).find(([, id]) => id === sessionId)?.[0]);
		register = vi.fn((sessionName: string, sessionId: string) => {
			const existing = sessionNameMappings.get(sessionName);
			if (existing && existing !== sessionId) {
				throw new Error(`Session name "${sessionName}" is already assigned to session "${existing}".`);
			}
			sessionNameMappings.set(sessionName, sessionId);
			return { sessionName, sessionId };
		});
	},
}));
vi.mock("../../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime", tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json", governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl", sessionArchiveFile: "/mock/runtime/session-archive.json",
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json", dagDir: "/mock/runtime/dag", dagIndexFile: "/mock/runtime/dag/dag-index.json",
	}),
}));
vi.mock("../../src/logger.js", () => ({ createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }), createNoopLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../../src/coordination/coordinator.js", () => ({ AgentCoordinator: vi.fn() }));
vi.mock("../../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: vi.fn() }), dagIndexEntryToWidgetDag: vi.fn() }));
vi.mock("../../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../../src/dag/dag-executor.js", () => ({ DagExecutor: vi.fn() }));
vi.mock("../../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));

import main from "../../index.js";
import { loadConfig } from "../../src/config/config.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { AcpTaskStore } from "../../src/management/task-store.js";
import { MailboxManager } from "../../src/management/mailbox-manager.js";
import { GovernanceStore } from "../../src/management/governance-store.js";
import { WorkerStore } from "../../src/management/worker-store.js";
import { AcpEventLog } from "../../src/management/event-log.js";
import { WorkerDispatcher } from "../../src/coordination/worker-dispatcher.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { HealthMonitor } from "../../src/core/health-monitor.js";
import { createAdapter } from "../../src/adapter-factory.js";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";

const CFG = {
	agent_servers: {
		gemini: { command: "gemini", args: ["--acp"] },
		claude: { command: "claude", args: ["--acp"] },
	},
	defaultAgent: "gemini", staleTimeoutMs: 3_600_000, circuitBreakerMaxFailures: 3, circuitBreakerResetMs: 60_000,
	stallTimeoutMs: 300_000, modelPolicy: {},
};

function mkSession(id: string, agent = "gemini", sessionName?: string): AcpSessionHandle {
	return {
		sessionId: id, sessionName, agentName: agent, cwd: "/tmp", createdAt: new Date(), lastActivityAt: new Date(),
		lastResponseAt: undefined, completedAt: undefined, accumulatedText: "", disposed: false, busy: false,
		autoClosed: false, closeReason: undefined, planStatus: "none", dispose: vi.fn(),
	};
}

/** The 13-tool target registry (11 core + 2 hooks policy). */
const TARGET_TOOLS = [
	"acp_spawn", "acp_msg", "acp_fanout", "acp_governance", "acp_status",
	"acp_task_create", "acp_task_update", "acp_message",
	"acp_dag_submit", "acp_dag_status", "acp_dag_cancel",
	"acp_hooks_policy_get", "acp_hooks_policy_set",
] as const;

/** Old tool names that MUST be absent from the registry after unification. */
const REMOVED_TOOLS = [
	"acp_delegate", "acp_session_new", "acp_worker_spawn", "acp_prompt", "acp_session_load",
	"acp_worker_steer", "acp_cancel", "acp_broadcast", "acp_compare", "acp_delegate_parallel",
	"acp_plan_request", "acp_plan_resolve", "acp_model_policy_get", "acp_model_policy_check",
	"acp_session_list", "acp_session_shutdown", "acp_session_kill", "acp_runtime_info",
	"acp_event_log", "acp_env", "acp_doctor", "acp_cleanup", "acp_prune",
	"acp_worker_list", "acp_worker_shutdown", "acp_worker_kill", "acp_worker_prune",
] as const;

describe("Unified ACP Tool Surface (RED)", () => {
	let tools: Map<string, any>;
	let m: any;
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	beforeEach(() => {
		sessionArchiveMappings.clear();
		sessionNameMappings.clear();
		tools = new Map();
		m = {
			sm: {
				add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []),
				remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0,
			},
			ts: {
				create: vi.fn((i: any) => ({ id: "t1", subject: i.subject, description: i.description ?? null, status: "pending", assignee: i.assignee ?? null, blockedBy: [], result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
				get: vi.fn(), update: vi.fn((_id: string, mut: (t: any) => void) => { const t: any = { id: _id, subject: "mock", status: "pending", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" }; mut(t); return t; }),
				list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })),
			},
			mb: {
				send: vi.fn((i: any) => ({ id: "m1", from: i.from, to: i.to, message: i.message, kind: i.kind, createdAt: new Date().toISOString() })),
				listFor: vi.fn(() => []), clearFor: vi.fn(() => 0),
			},
			gs: {
				getPlan: vi.fn(),
				requestPlan: vi.fn((a: string) => ({ agent: a, status: "pending", requestedAt: new Date().toISOString() })),
				resolvePlan: vi.fn((a: string, s: string) => ({ agent: a, status: s, requestedAt: new Date().toISOString(), resolvedAt: new Date().toISOString() })),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: vi.fn(),
				checkModel: vi.fn(() => ({ ok: true, reason: "" })),
			},
			ws: {
				register: vi.fn((i: any) => ({ name: i.name, sessionId: i.sessionId, agentName: i.agentName, status: "online" })),
				get: vi.fn(),
				list: vi.fn(() => []),
				updateStatus: vi.fn(),
				updateMetadata: vi.fn(),
				assignTask: vi.fn(),
				unassignTask: vi.fn(),
				touch: vi.fn(),
			},
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" },
			hm: { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() },
			ad: {
				spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "ses-1"),
				loadSession: vi.fn(async (sessionId?: string) => sessionId ?? "ses-l"),
				prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "ses-1" })),
				setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
			},
			co: {
				delegate: vi.fn(async () => ({ text: "delegated", stopReason: "end_turn", sessionId: "d1" })),
				broadcast: vi.fn(async () => [{ agent: "gemini", text: "g" }, { agent: "claude", text: "c" }]),
				compare: vi.fn(async () => ({ responses: [{ agent: "gemini", text: "go" }, { agent: "claude", text: "co" }], timestamp: new Date().toISOString() })),
				dispose: vi.fn(),
			},
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return m.sm; });
		(AcpTaskStore as any).mockImplementation(function () { return m.ts; });
		(MailboxManager as any).mockImplementation(function () { return m.mb; });
		(GovernanceStore as any).mockImplementation(function () { return m.gs; });
		(WorkerStore as any).mockImplementation(function () { return m.ws; });
		(AcpEventLog as any).mockImplementation(function () { return m.el; });
		(WorkerDispatcher as any).mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() } });
		(AcpCircuitBreaker as any).mockImplementation(function () { return m.cb; });
		(HealthMonitor as any).mockImplementation(function () { return m.hm; });
		(createAdapter as any).mockImplementation(function () { return m.ad; });
		(AgentCoordinator as any).mockImplementation(function () { return m.co; });

		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
	});

	const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);
	const paramsFor = (name: string) => (tools.get(name)?.parameters as any)?.properties ?? {};

	// ── unify-red-removal: registry shape ──────────────────────────────
	describe("registry shape (unify-red-removal)", () => {
		it("registers exactly the 13 target tools (11 core + 2 hooks policy)", () => {
			expect(Array.from(tools.keys()).sort()).toEqual([...TARGET_TOOLS].sort());
		});

		it("registers every target tool", () => {
			for (const name of TARGET_TOOLS) {
				expect(tools.has(name), `expected ${name} to be registered`).toBe(true);
			}
		});

		it("does NOT register any of the collapsed/removed tool names", () => {
			const present = REMOVED_TOOLS.filter((n) => tools.has(n));
			expect(present, `removed tools still registered: ${present.join(", ")}`).toEqual([]);
		});

		it("does not keep acp_prompt as an alias", () => {
			expect(tools.has("acp_prompt")).toBe(false);
		});
	});

	// ── unify-red-spawn: acp_spawn ─────────────────────────────────────
	describe("acp_spawn (unify-red-spawn)", () => {
		it("is registered with agent + optional name/prompt/claim/idleTtlMs params", () => {
			expect(tools.has("acp_spawn")).toBe(true);
			const p = paramsFor("acp_spawn");
			expect(p).toHaveProperty("agent");
			expect(p).toHaveProperty("name");
			expect(p).toHaveProperty("prompt");
			expect(p).toHaveProperty("claim");
			expect(p).toHaveProperty("idleTtlMs");
		});

		it("default spawn creates a long-lived session and returns sessionId", async () => {
			const r = await exec("acp_spawn", { agent: "gemini" });
			expect(m.ad.spawn).toHaveBeenCalled();
			expect(m.ad.newSession).toHaveBeenCalled();
			expect(r.details.sessionId).toBe("ses-1");
			// Long-lived: not disposed at spawn time.
			expect(m.ad.dispose).not.toHaveBeenCalled();
		});

		it("idleTtlMs: 0 with prompt is a one-shot — disposes after responding", async () => {
			const r = await exec("acp_spawn", { agent: "gemini", prompt: "do it", idleTtlMs: 0 });
			expect(m.ad.prompt).toHaveBeenCalledWith("do it");
			expect(m.ad.dispose).toHaveBeenCalled();
			// One-shot returns the response text surface.
			expect(r.content[0].text).toContain("response");
		});

		it("claim: true registers the spawn as a worker in the auto-claim pool", async () => {
			await exec("acp_spawn", { agent: "gemini", name: "w1", claim: true });
			expect(m.ws.register).toHaveBeenCalledWith(expect.objectContaining({ name: "w1", agentName: "gemini" }));
		});

		it("without claim does NOT register a worker", async () => {
			await exec("acp_spawn", { agent: "gemini", name: "ephemeral" });
			expect(m.ws.register).not.toHaveBeenCalled();
		});
	});

	// ── unify-red-msg: acp_msg ─────────────────────────────────────────
	describe("acp_msg (unify-red-msg)", () => {
		it("is registered with to/message/cancel/queue params", () => {
			expect(tools.has("acp_msg")).toBe(true);
			const p = paramsFor("acp_msg");
			expect(p).toHaveProperty("to");
			expect(p).toHaveProperty("message");
			expect(p).toHaveProperty("cancel");
		});

		it("prompts an alive session and returns the response", async () => {
			// Seed an alive session by name.
			const h = mkSession("ses-1", "gemini", "alice");
			m.sm.get.mockReturnValue(h);
			sessionNameMappings.set("alice", "ses-1");
			const r = await exec("acp_msg", { to: "alice", message: "hi" });
			expect(m.ad.prompt).toHaveBeenCalledWith("hi");
			expect(r.content[0].text).toContain("response");
		});

		it("cancel: true aborts the in-flight turn", async () => {
			const h = mkSession("ses-1", "gemini", "alice");
			m.sm.get.mockReturnValue(h);
			sessionNameMappings.set("alice", "ses-1");
			const r = await exec("acp_msg", { to: "alice", message: "stop", cancel: true });
			expect(m.ad.cancel).toHaveBeenCalled();
			expect(r.details.cancelled).toBe(true);
		});

		it("reopens a disposed/archived session before prompting", async () => {
			const archived = { ...mkSession("arch-1", "gemini", "ghost"), disposed: true, closeReason: "manual-shutdown" };
			sessionNameMappings.set("ghost", "arch-1");
			sessionArchiveMappings.set("arch-1", archived as any);
			// After reopen, a fresh adapter is spawned.
			m.ad.newSession.mockResolvedValueOnce("arch-1");
			const r = await exec("acp_msg", { to: "ghost", message: "hi" });
			expect(m.ad.spawn).toHaveBeenCalled();
			expect(m.ad.prompt).toHaveBeenCalledWith("hi");
			expect(r.content[0].text).toContain("response");
		});

		it("queues a steer prefix when the target worker is busy", async () => {
			// Worker exists and is busy (currentTaskId set).
			m.ws.get.mockReturnValue({ name: "w1", sessionId: "ses-w", agentName: "gemini", currentTaskId: "t1", status: "busy" });
			sessionNameMappings.set("w1", "ses-w");
			const r = await exec("acp_msg", { to: "w1", message: "steer-me" });
			expect(m.ws.updateMetadata).toHaveBeenCalledWith("w1", expect.objectContaining({ pendingSteer: "steer-me" }));
			expect(r.details.queued).toBe(true);
		});
	});

	// ── unify-red-fanout: acp_fanout ───────────────────────────────────
	describe("acp_fanout (unify-red-fanout)", () => {
		it("is registered with message/agents/compare params", () => {
			expect(tools.has("acp_fanout")).toBe(true);
			const p = paramsFor("acp_fanout");
			expect(p).toHaveProperty("message");
			expect(p).toHaveProperty("agents");
			expect(p).toHaveProperty("compare");
		});

		it("dispatches a message to multiple agents via broadcast", async () => {
			await exec("acp_fanout", { message: "hey", agents: ["gemini", "claude"] });
			expect(m.co.broadcast).toHaveBeenCalledWith(["gemini", "claude"], "hey", "/project");
		});

		it("compare: true routes through the compare path", async () => {
			const r = await exec("acp_fanout", { message: "cmp", agents: ["gemini", "claude"], compare: true });
			expect(m.co.compare).toHaveBeenCalled();
			expect(r.details).toBeTruthy();
		});
	});

	// ── unify-red-governance: acp_governance ───────────────────────────
	describe("acp_governance (unify-red-governance)", () => {
		it("is registered with an `action` discriminator param", () => {
			expect(tools.has("acp_governance")).toBe(true);
			const p = paramsFor("acp_governance");
			expect(p).toHaveProperty("action");
		});

		it("action: plan_request routes to governanceStore.requestPlan", async () => {
			await exec("acp_governance", { action: "plan_request", agent: "gemini" });
			expect(m.gs.requestPlan).toHaveBeenCalledWith("gemini");
		});

		it("action: plan_resolve routes to governanceStore.resolvePlan", async () => {
			await exec("acp_governance", { action: "plan_resolve", agent: "gemini", status: "approved" });
			expect(m.gs.resolvePlan).toHaveBeenCalledWith("gemini", "approved");
		});

		it("action: model_policy_get returns the model policy", async () => {
			const r = await exec("acp_governance", { action: "model_policy_get" });
			expect(m.gs.getModelPolicy).toHaveBeenCalled();
			expect(r.details).toEqual({ allowedModels: [], blockedModels: [] });
		});

		it("action: model_policy_check routes to governanceStore.checkModel", async () => {
			m.gs.checkModel.mockReturnValue({ ok: false, reason: "blocked" });
			const r = await exec("acp_governance", { action: "model_policy_check", model: "bad" });
			expect(m.gs.checkModel).toHaveBeenCalledWith("bad");
			expect(r.details.ok).toBe(false);
		});

		it("rejects an unknown action", async () => {
			const r = await exec("acp_governance", { action: "nope" });
			expect(r.details.error).toBeTruthy();
		});
	});

	// ── unify-red-status: acp_status cleanup/prune actions ─────────────
	describe("acp_status (unify-red-status)", () => {
		it("accepts an optional `action` param (cleanup|prune)", () => {
			expect(tools.has("acp_status")).toBe(true);
			const p = paramsFor("acp_status");
			expect(p).toHaveProperty("action");
		});

		it("action: prune absorbs acp_worker_prune — marks stale workers offline", async () => {
			// One stale worker, one healthy.
			m.ws.list.mockReturnValue([
				{ name: "stale-w", sessionId: "s1", agentName: "gemini", status: "online", currentTaskId: null, lastActivityAt: new Date(0), spawnedAt: new Date(0), lastHeartbeatAt: null, tokenCountTotal: 0, toolCallCount: 0 },
				{ name: "fresh-w", sessionId: "s2", agentName: "gemini", status: "online", currentTaskId: null, lastActivityAt: new Date(), spawnedAt: new Date(), lastHeartbeatAt: new Date(), tokenCountTotal: 0, toolCallCount: 0 },
			]);
			const r = await exec("acp_status", { action: "prune" });
			expect(m.ws.updateStatus).toHaveBeenCalledWith("stale-w", "offline");
			expect(r.details.pruned).toContain("stale-w");
		});

		it("action: cleanup absorbs acp_cleanup — removes sessions, clears tasks/mailboxes", async () => {
			m.sm.list.mockReturnValue([mkSession("s1")]);
			await exec("acp_status", { action: "cleanup", target: "all" });
			expect(m.sm.remove).toHaveBeenCalledWith("s1");
			expect(m.ts.clear).toHaveBeenCalled();
		});

		it("default (no action) still reports overall status", async () => {
			m.sm.size = 1;
			m.sm.list.mockReturnValue([mkSession("s1")]);
			const r = await exec("acp_status", {});
			expect(r.content[0].text).toContain("Agent Servers: 2 configured");
		});
	});

	// ── Sanity: the already-consolidated tools are unchanged ───────────
	describe("preserved tools (already consolidated)", () => {
		it("keeps acp_task_create, acp_task_update, acp_message, and the 3 DAG tools", () => {
			for (const name of ["acp_task_create", "acp_task_update", "acp_message", "acp_dag_submit", "acp_dag_status", "acp_dag_cancel"]) {
				expect(tools.has(name), `expected ${name} to remain registered`).toBe(true);
			}
		});
	});
});

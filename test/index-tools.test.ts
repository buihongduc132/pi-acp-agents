/**
 * Tests for all 33 MCP tools registered by index.ts
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpSessionHandle } from "../src/config/types.js";

vi.mock("../src/config/config.js", async (imp) => ({ ...await imp(), loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", async (imp) => ({ ...await imp(), SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", async (imp) => ({ ...await imp(), AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", async (imp) => ({ ...await imp(), MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", async (imp) => ({ ...await imp(), GovernanceStore: vi.fn() }));
vi.mock("../src/management/event-log.js", async (imp) => ({ ...await imp(), AcpEventLog: vi.fn() }));
vi.mock("../src/management/session-archive-store.js", () => ({
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
vi.mock("../src/management/session-name-store.js", () => ({
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
vi.mock("../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime", tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json", governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl", sessionArchiveFile: "/mock/runtime/session-archive.json",
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json",
	}),
}));
vi.mock("../src/logger.js", () => ({ createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../src/core/circuit-breaker.js", async (imp) => ({ ...await imp(), AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", async (imp) => ({ ...await imp(), HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", async (imp) => ({ ...await imp(), createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", async (imp) => ({ ...await imp(), AgentCoordinator: vi.fn() }));
vi.mock("../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: vi.fn() }) }));

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

const CFG = {
	agent_servers: { gemini: { command: "gemini", args: ["--acp"] }, claude: { command: "claude", args: ["--acp"] } },
	defaultAgent: "gemini", staleTimeoutMs: 3_600_000, circuitBreakerMaxFailures: 3, circuitBreakerResetMs: 60_000,
	stallTimeoutMs: 300_000, modelPolicy: {},
};

function mkSession(id: string, agent = "gemini", sessionName?: string): AcpSessionHandle {
	return { sessionId: id, sessionName, agentName: agent, cwd: "/tmp", createdAt: new Date(), lastActivityAt: new Date(),
		lastResponseAt: undefined, completedAt: undefined, accumulatedText: "", disposed: false, busy: false,
		autoClosed: false, closeReason: undefined, planStatus: "none", dispose: vi.fn() };
}

describe("ACP Extension Tools", () => {
	let tools: Map<string, any>;
	let m: any;
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	beforeEach(() => {
		vi.clearAllMocks();
		sessionArchiveMappings.clear();
		sessionNameMappings.clear();
		tools = new Map();
		m = {
			sm: { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0 },
			ts: { create: vi.fn((i) => ({ id: "t1", subject: i.subject, description: i.description ?? null, status: "pending", assignee: i.assignee ?? null, blockedBy: [], result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
				get: vi.fn(), update: vi.fn((_id, mut) => { const t: any = { id: _id, subject: "mock", status: "pending", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" }; mut(t); return t; }),
				list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: vi.fn((i) => ({ id: "m1", from: i.from, to: i.to, message: i.message, kind: i.kind, createdAt: new Date().toISOString() })),
				listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) },
			gs: { getPlan: vi.fn(), requestPlan: vi.fn((a) => ({ agent: a, status: "pending", requestedAt: new Date().toISOString() })),
				resolvePlan: vi.fn((a, s) => ({ agent: a, status: s, requestedAt: new Date().toISOString(), resolvedAt: new Date().toISOString() })),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) },
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" },
			hm: { start: vi.fn(), stop: vi.fn(), register: vi.fn() },
			ad: { spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "ses-1"), loadSession: vi.fn(async (sessionId?: string) => sessionId ?? "ses-l"),
				prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "ses-1" })), setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn() },
			co: { delegate: vi.fn(async () => ({ text: "delegated", stopReason: "end_turn", sessionId: "d1" })),
				broadcast: vi.fn(async () => [{ agent: "gemini", text: "g" }, { agent: "claude", text: "c" }]),
				compare: vi.fn(async () => ({ responses: [{ agent: "gemini", text: "go" }, { agent: "claude", text: "co" }], timestamp: new Date().toISOString() })) },
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function() { return m.sm; });
		(AcpTaskStore as any).mockImplementation(function() { return m.ts; });
		(MailboxManager as any).mockImplementation(function() { return m.mb; });
		(GovernanceStore as any).mockImplementation(function() { return m.gs; });
		(AcpEventLog as any).mockImplementation(function() { return m.el; });
		(AcpCircuitBreaker as any).mockImplementation(function() { return m.cb; });
		(HealthMonitor as any).mockImplementation(function() { return m.hm; });
		(createAdapter as any).mockImplementation(function() { return m.ad; });
		(AgentCoordinator as any).mockImplementation(function() { return m.co; });

		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
	});

	const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);
	const paramsFor = (name: string) => (tools.get(name)?.parameters as any)?.properties ?? {};

	// Helper: create session then return handle for follow-up calls
	async function createAndGetSession() {
		await exec("acp_session_new", {});
		const h = m.sm.add.mock.calls[0]?.[0];
		if (h) m.sm.get.mockReturnValue(h);
		return h;
	}

	it("registers 33 tools", () => { expect(tools.size).toBe(33); });

	it("acp_status overall", async () => { m.sm.size = 1; m.sm.list.mockReturnValue([mkSession("s1")]); const r = await exec("acp_status", {}); expect(r.content[0].text).toContain("Agent Servers: 2 configured"); });
	it("acp_status specific", async () => { m.sm.get.mockReturnValue(mkSession("s1")); const r = await exec("acp_status", { session_id: "s1" }); expect(r.content[0].text).toContain("Session: s1"); });
	it("tool schemas expose friendly session names", () => {
		expect(paramsFor("acp_session_new")).toHaveProperty("session_name");
		for (const toolName of ["acp_prompt", "acp_session_load", "acp_status", "acp_session_set_model", "acp_session_set_mode", "acp_cancel", "acp_session_shutdown", "acp_session_kill"]) {
			expect(paramsFor(toolName)).toHaveProperty("session_name");
		}
	});
	it("acp_status resolves session_name", async () => { sessionNameMappings.set("alpha", "s1"); m.sm.get.mockReturnValue(mkSession("s1", "gemini", "alpha")); const r = await exec("acp_status", { session_name: "alpha" }); expect(r.content[0].text).toContain("Name:    alpha"); });
	it("acp_status missing", async () => { m.sm.get.mockReturnValue(undefined); const r = await exec("acp_status", { session_id: "x" }); expect(r.content[0].text).toContain("not found"); });
	it("acp_prompt new session", async () => { const r = await exec("acp_prompt", { message: "hi" }); expect(r.content[0].text).toBe("response"); });
	it("acp_prompt spawn error", async () => { m.ad.spawn.mockRejectedValueOnce(new Error("boom")); const r = await exec("acp_prompt", { message: "hi" }); expect(r.content[0].text).toContain("boom"); expect(m.ad.dispose).toHaveBeenCalled(); });
	it("acp_prompt circuit open", async () => { const e: any = new Error("open"); e.name = "CircuitOpenError"; m.cb.execute.mockRejectedValueOnce(e); const r = await exec("acp_prompt", { message: "hi" }); expect(r.content[0].text).toContain("Circuit breaker open"); });
	it("acp_session_new creates", async () => { const r = await exec("acp_session_new", { agent: "claude", session_name: "alpha" }); expect(r.content[0].text).toContain("alpha"); expect(r.details.sessionId).toBe("ses-1"); expect(m.sm.add.mock.calls[0]?.[0]?.sessionName).toBe("alpha"); });
	it("acp_session_new rejects duplicate session names", async () => {
		const duplicate = new Error('Session name "alpha" is already assigned to session "ses-old".');
		m.cb.execute.mockRejectedValueOnce(duplicate);
		const r = await exec("acp_session_new", { session_name: "alpha" });
		expect(r.content[0].text).toContain('Session name "alpha" is already assigned');
	});
	it("acp_session_new rejects caller-selected ID", async () => { const r = await exec("acp_session_new", { session_id: "picked" }); expect(r.details.error).toBe("session_id_not_allowed"); });
	it("acp_session_new failure", async () => { m.ad.spawn.mockRejectedValueOnce(new Error("fail")); const r = await exec("acp_session_new", {}); expect(r.content[0].text).toContain("fail"); });

	it("acp_session_set_model", async () => { const h = await createAndGetSession(); if (!h) return; const r = await exec("acp_session_set_model", { session_id: h.sessionId, model_id: "pro" }); expect(r.content[0].text).toContain("pro"); });
	it("acp_prompt reuses session by session_name", async () => { const h = await createAndGetSession(); if (!h) return; h.sessionName = "alpha"; m.sm.get.mockReturnValue(h); const r = await exec("acp_prompt", { message: "hi", session_name: "alpha" }); expect(r.details.sessionId).toBe(h.sessionId); });
	it("acp_session_load resolves archived session by session_name", async () => { sessionNameMappings.set("alpha", "arch-1"); sessionArchiveMappings.set("arch-1", mkSession("arch-1", "gemini", "alpha")); const r = await exec("acp_session_load", { session_name: "alpha" }); expect(r.details.sessionId).toBe("arch-1"); });
	it("acp_session_new rejects whitespace-only session_name", async () => { const r = await exec("acp_session_new", { session_name: "   " }); expect(r.content[0].text).toContain("session_name is required"); });
	it("acp_session_new trims session_name before registering", async () => { await exec("acp_session_new", { session_name: "  alpha  " }); expect(sessionNameMappings.get("alpha")).toBe("ses-1"); expect(sessionNameMappings.has("  alpha  ")).toBe(false); });
	it("acp_status rejects conflicting session_id and session_name targets", async () => { m.sm.get.mockImplementation((sessionId: string) => sessionId === "s1" ? mkSession("s1", "gemini", "alpha") : undefined); sessionNameMappings.set("beta", "s2"); sessionArchiveMappings.set("s2", mkSession("s2", "gemini", "beta")); const r = await exec("acp_status", { session_id: "s1", session_name: "beta" }); expect(r.content[0].text).toContain('session_id "s1" does not match session_name "beta"'); });
	it("acp_session_load rejects unresolved session_id when session_name resolves elsewhere", async () => { sessionNameMappings.set("alpha", "arch-1"); sessionArchiveMappings.set("arch-1", mkSession("arch-1", "gemini", "alpha")); const r = await exec("acp_session_load", { session_id: "missing", session_name: "alpha" }); expect(r.content[0].text).toContain('session_id "missing" was not found and does not match resolved session_name "alpha"'); });
	it("acp_status resolves archived session metadata by session_name", async () => { sessionNameMappings.set("archived-alpha", "arch-1"); sessionArchiveMappings.set("arch-1", mkSession("arch-1", "gemini", "archived-alpha")); const r = await exec("acp_status", { session_name: "archived-alpha" }); expect(r.content[0].text).toContain("Session: arch-1"); });
	it("acp_prompt rejects archived-only session_name targets", async () => { sessionNameMappings.set("archived-alpha", "arch-1"); sessionArchiveMappings.set("arch-1", { ...mkSession("arch-1", "gemini", "archived-alpha"), disposed: true, closeReason: "manual-shutdown" }); const r = await exec("acp_prompt", { message: "hi", session_name: "archived-alpha" }); expect(r.content[0].text).toContain('Session name "archived-alpha" refers to archived session "arch-1"'); });
	it("acp_session_set_model resolves session_name", async () => { const h = await createAndGetSession(); if (!h) return; h.sessionName = "alpha"; sessionNameMappings.set("alpha", h.sessionId); m.sm.get.mockReturnValue(h); const r = await exec("acp_session_set_model", { session_name: "alpha", model_id: "pro" }); expect(r.details.sessionId).toBe(h.sessionId); });
	it("acp_session_set_model missing", async () => { m.sm.get.mockReturnValue(undefined); const r = await exec("acp_session_set_model", { session_id: "x", model_id: "m" }); expect(r.content[0].text).toContain("not found"); });
	it("acp_session_set_mode", async () => { const h = await createAndGetSession(); if (!h) return; const r = await exec("acp_session_set_mode", { session_id: h.sessionId, mode_id: "yolo" }); expect(r.content[0].text).toContain("yolo"); });
	it("acp_session_set_mode resolves session_name", async () => { const h = await createAndGetSession(); if (!h) return; h.sessionName = "alpha"; sessionNameMappings.set("alpha", h.sessionId); m.sm.get.mockReturnValue(h); const r = await exec("acp_session_set_mode", { session_name: "alpha", mode_id: "yolo" }); expect(r.details.sessionId).toBe(h.sessionId); });
	it("acp_cancel", async () => { const h = await createAndGetSession(); if (!h) return; const r = await exec("acp_cancel", { session_id: h.sessionId }); expect(r.details.cancelled).toBe(true); });
	it("acp_cancel resolves session_name", async () => { const h = await createAndGetSession(); if (!h) return; h.sessionName = "alpha"; sessionNameMappings.set("alpha", h.sessionId); m.sm.get.mockReturnValue(h); const r = await exec("acp_cancel", { session_name: "alpha" }); expect(r.details.sessionId).toBe(h.sessionId); });
	it("acp_cancel missing", async () => { m.sm.get.mockReturnValue(undefined); const r = await exec("acp_cancel", { session_id: "x" }); expect(r.details.cancelled).toBe(false); });

	it("acp_delegate", async () => { const r = await exec("acp_delegate", { agent: "claude", message: "do" }); expect(r.content[0].text).toBe("delegated"); });
	it("acp_delegate error", async () => { m.co.delegate.mockRejectedValueOnce(new Error("fail")); const r = await exec("acp_delegate", { message: "x" }); expect(r.content[0].text).toContain("fail"); });
	it("acp_broadcast", async () => { const r = await exec("acp_broadcast", { message: "hey" }); expect(r.content[0].text).toContain("g"); expect(r.content[0].text).toContain("c"); });
	it("acp_broadcast specific agents", async () => { await exec("acp_broadcast", { message: "hey", agents: ["gemini"] }); expect(m.co.broadcast).toHaveBeenCalledWith(["gemini"], "hey", "/project"); });
	it("acp_compare", async () => { const r = await exec("acp_compare", { message: "cmp" }); expect(r.content[0].text).toContain("go"); });

	it("acp_session_list", async () => { m.sm.listByAgent.mockReturnValue([mkSession("s1")]); const r = await exec("acp_session_list", {}); expect(r.details.sessions).toHaveLength(1); });
	it("acp_session_shutdown all", async () => { m.sm.list.mockReturnValue([mkSession("s1")]); const r = await exec("acp_session_shutdown", { all: true }); expect(r.content[0].text).toContain("s1"); });
	it("acp_session_shutdown no match", async () => { const r = await exec("acp_session_shutdown", { session_id: "x" }); expect(r.content[0].text).toContain("No matching"); });
	it("acp_session_shutdown resolves session_name", async () => { const h = mkSession("s1", "gemini", "alpha"); sessionNameMappings.set("alpha", "s1"); m.sm.get.mockReturnValue(h); const r = await exec("acp_session_shutdown", { session_name: "alpha" }); expect(r.content[0].text).toContain("s1"); });
	it("acp_session_kill", async () => { const h = mkSession("s1"); m.sm.get.mockReturnValue(h); await exec("acp_session_kill", { session_id: "s1" }); expect(h.disposed).toBe(true); });
	it("acp_session_kill resolves session_name", async () => { const h = mkSession("s1", "gemini", "alpha"); sessionNameMappings.set("alpha", "s1"); m.sm.get.mockReturnValue(h); const r = await exec("acp_session_kill", { session_name: "alpha" }); expect(r.details.sessionId).toBe("s1"); });
	it("acp_session_kill missing", async () => { m.sm.get.mockReturnValue(undefined); const r = await exec("acp_session_kill", { session_id: "x" }); expect(r.content[0].text).toContain("not found"); });
	it("acp_prune", async () => { const stale = mkSession("old"); stale.busy = true; stale.lastResponseAt = new Date(Date.now() - 5_000); m.sm.list.mockReturnValue([stale]); const r = await exec("acp_prune", { stale_after_ms: 1000 }); expect(r.content[0].text).toContain("old"); });
	it("acp_prune default threshold", async () => { const stale = mkSession("old"); stale.completedAt = new Date(Date.now() - 4_000_000); m.sm.list.mockReturnValue([stale]); await exec("acp_prune", {}); expect(m.sm.list).toHaveBeenCalled(); });

	it("acp_runtime_info", async () => { m.sm.size = 5; const r = await exec("acp_runtime_info", {}); const payload = JSON.parse(r.content[0].text); expect(payload.runtimeDir).toBe("/mock/runtime"); expect(payload.sessionArchiveFile).toBe("/mock/runtime/session-archive.json"); expect(payload.sessionNameRegistryFile).toBe("/mock/runtime/session-name-registry.json"); });
	it("acp_env", async () => { const r = await exec("acp_env", { agent: "gemini" }); expect(JSON.parse(r.content[0].text).command).toBe("gemini"); });

	it("acp_task_create", async () => { const r = await exec("acp_task_create", { subject: "Do it" }); expect(JSON.parse(r.content[0].text).subject).toBe("Do it"); });
	it("acp_task_list", async () => { m.ts.list.mockReturnValue([{ id: "1" }]); const r = await exec("acp_task_list", {}); expect(r.details.tasks).toHaveLength(1); });
	it("acp_task_list filter", async () => { await exec("acp_task_list", { status: "completed", include_deleted: true }); expect(m.ts.list).toHaveBeenCalledWith({ status: "completed", includeDeleted: true }); });
	it("acp_task_get", async () => { m.ts.get.mockReturnValue({ id: "1", subject: "x" }); const r = await exec("acp_task_get", { task_id: "1" }); expect(JSON.parse(r.content[0].text).subject).toBe("x"); });
	it("acp_task_get missing", async () => { m.ts.get.mockReturnValue(undefined); const r = await exec("acp_task_get", { task_id: "x" }); expect(r.content[0].text).toContain("not found"); });
	it("acp_task_assign", async () => { await exec("acp_task_assign", { task_id: "1", assignee: "g" }); expect(m.ts.update).toHaveBeenCalled(); });
	it("acp_task_set_status", async () => { await exec("acp_task_set_status", { task_id: "1", status: "done" }); expect(m.ts.update).toHaveBeenCalled(); });
	it("acp_task_dependency_add", async () => { await exec("acp_task_dependency_add", { task_id: "1", dependency_id: "2" }); expect(m.ts.update).toHaveBeenCalled(); });
	it("acp_task_dependency_remove", async () => { await exec("acp_task_dependency_remove", { task_id: "1", dependency_id: "2" }); expect(m.ts.update).toHaveBeenCalled(); });
	it("acp_task_clear completed", async () => { await exec("acp_task_clear", {}); expect(m.ts.clear).toHaveBeenCalledWith("completed"); });
	it("acp_task_clear all", async () => { await exec("acp_task_clear", { mode: "all" }); expect(m.ts.clear).toHaveBeenCalledWith("all"); });

	it("acp_message_send dm", async () => { await exec("acp_message_send", { to: "gemini", message: "hi" }); expect(m.mb.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "dm" })); });
	it("acp_message_send broadcast", async () => { await exec("acp_message_send", { to: "*", message: "all" }); expect(m.mb.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "broadcast" })); });
	it("acp_message_send steer", async () => { await exec("acp_message_send", { to: "g", message: "s", kind: "steer" }); expect(m.mb.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "steer" })); });
	it("acp_message_list", async () => { m.mb.listFor.mockReturnValue([{ id: "1" }]); const r = await exec("acp_message_list", { recipient: "g" }); expect(r.details.messages).toHaveLength(1); });

	it("acp_plan_request", async () => { const s = mkSession("s1"); m.sm.listByAgent.mockReturnValue([s]); const r = await exec("acp_plan_request", { agent: "gemini" }); expect(JSON.parse(r.content[0].text).status).toBe("pending"); expect(s.planStatus).toBe("pending"); });
	it("acp_plan_resolve approve", async () => { const s = mkSession("s1"); m.sm.listByAgent.mockReturnValue([s]); const r = await exec("acp_plan_resolve", { agent: "gemini", action: "approved" }); expect(JSON.parse(r.content[0].text).status).toBe("approved"); expect(s.planStatus).toBe("approved"); });
	it("acp_plan_resolve invalid", async () => { const r = await exec("acp_plan_resolve", { agent: "gemini", action: "maybe" }); expect(r.content[0].text).toBe("action must be approved or rejected"); });

	it("acp_model_policy_get", async () => { const r = await exec("acp_model_policy_get", {}); expect(JSON.parse(r.content[0].text)).toEqual({ allowedModels: [], blockedModels: [] }); });
	it("acp_model_policy_check", async () => { m.gs.checkModel.mockReturnValue({ ok: false, reason: "blocked" }); const r = await exec("acp_model_policy_check", { model: "bad" }); expect(JSON.parse(r.content[0].text).ok).toBe(false); });
	it("acp_doctor", async () => { m.sm.size = 3; m.ts.list.mockReturnValue([{}, {}, {}]); const r = await exec("acp_doctor", {}); expect(JSON.parse(r.content[0].text).sessionCount).toBe(3); });
	it("acp_event_log", async () => { const r = await exec("acp_event_log", {}); expect(r.content[0].text).toBe("/mock/runtime/events.jsonl"); });

	it("acp_cleanup all", async () => { m.sm.list.mockReturnValue([mkSession("s1")]); await exec("acp_cleanup", { target: "all" }); expect(m.sm.remove).toHaveBeenCalledWith("s1"); expect(m.ts.clear).toHaveBeenCalledWith("all"); });
	it("acp_cleanup sessions", async () => { m.sm.list.mockReturnValue([mkSession("s1")]); await exec("acp_cleanup", { target: "sessions" }); expect(m.sm.remove).toHaveBeenCalledWith("s1"); expect(m.ts.clear).not.toHaveBeenCalled(); });
	it("acp_cleanup tasks", async () => { await exec("acp_cleanup", { target: "tasks" }); expect(m.sm.remove).not.toHaveBeenCalled(); expect(m.ts.clear).toHaveBeenCalledWith("all"); });
	it("acp_cleanup mailboxes", async () => { await exec("acp_cleanup", { target: "mailboxes" }); expect(m.mb.clearFor).toHaveBeenCalledWith("gemini"); expect(m.mb.clearFor).toHaveBeenCalledWith("claude"); expect(m.mb.clearFor).toHaveBeenCalledWith("*"); });
});

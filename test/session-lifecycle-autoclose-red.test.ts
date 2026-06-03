import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { HealthMonitor } from "../src/core/health-monitor.js";
import type { AcpSessionHandle } from "../src/config/types.js";

const archivedStore = new Map<string, AcpSessionHandle>();

mock.module("../src/config/config.js", () => ({ loadConfig: mock() }));
mock.module("../src/core/session-manager.js", () => ({ SessionManager: mock() }));
mock.module("../src/management/task-store.js", () => ({ AcpTaskStore: mock() }));
mock.module("../src/management/mailbox-manager.js", () => ({ MailboxManager: mock() }));
mock.module("../src/management/governance-store.js", () => ({ GovernanceStore: mock() }));
mock.module("../src/management/event-log.js", () => ({ AcpEventLog: mock() }));
mock.module("../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class MockSessionArchiveStore {
		get = mock((sessionId: string) => archivedStore.get(sessionId));
		upsert = mock((session: AcpSessionHandle) => {
			archivedStore.set(session.sessionId, { ...session });
			return archivedStore.get(session.sessionId);
		});
	},
}));
mock.module("../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime",
		tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json",
		governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl",
		sessionArchiveFile: "/mock/runtime/session-archive.json",
	}),
}));
mock.module("../src/logger.js", () => ({ createFileLogger: () => ({ info: mock(), error: mock(), debug: mock() }) }));
mock.module("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: mock() }));
mock.module("../src/adapter-factory.js", () => ({ createAdapter: mock() }));
mock.module("../src/coordination/coordinator.js", () => ({ AgentCoordinator: mock() }));
mock.module("../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: mock() }) }));

import main from "../index.js";
import { loadConfig } from "../src/config/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AcpTaskStore } from "../src/management/task-store.js";
import { MailboxManager } from "../src/management/mailbox-manager.js";
import { GovernanceStore } from "../src/management/governance-store.js";
import { AcpEventLog } from "../src/management/event-log.js";
import { AcpCircuitBreaker } from "../src/core/circuit-breaker.js";
import { createAdapter } from "../src/adapter-factory.js";
import { AgentCoordinator } from "../src/coordination/coordinator.js";

/** Helper: create a date that is `msAgo` milliseconds before now */
function ago(msAgo: number): Date {
	return new Date(Date.now() - msAgo);
}

function makeHandle(id: string): AcpSessionHandle {
	return {
		sessionId: id,
		agentName: "gemini",
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
		dispose: mock(async () => {}),
	};
}

describe("ACP/Gemini session auto-close lifecycle", () => {
	beforeEach(() => {
		archivedStore.clear();
	});

	afterEach(() => {
	});

	it("auto-closes an active session after 1 hour with no new response, not based only on lastActivityAt", async () => {
		const monitor = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
		});
		const session = {
			...makeHandle("active-no-response"),
			busy: true,
			lastActivityAt: new Date(),
			lastResponseAt: ago(3_600_001),
		};

		monitor.register(session as any);
		const staleIds = await monitor.check();

		expect(staleIds).toContain("active-no-response");
	});

	it("auto-closes a completed session after 1 hour idle, distinct from active waiting-for-response", async () => {
		const monitor = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
		});
		const session = {
			...makeHandle("completed-idle"),
			busy: false,
			lastActivityAt: new Date(),
			completedAt: ago(3_600_001),
		};

		monitor.register(session as any);
		const staleIds = await monitor.check();

		expect(staleIds).toContain("completed-idle");
	});

	it("does not auto-close a busy session with no lastResponseAt yet", async () => {
		const monitor = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
		});
		const session = {
			...makeHandle("waiting-first-response"),
			busy: true,
			lastActivityAt: ago(7_200_000),
			lastResponseAt: undefined,
		};

		monitor.register(session as any);
		const staleIds = await monitor.check();

		expect(staleIds).not.toContain("waiting-first-response");
	});

	it("auto-closes with exact stalled-no-response reason, archives metadata, and resumes with archived agent/cwd", async () => {
		const CFG = {
			agent_servers: {
				gemini: { command: "gemini", args: ["--acp"] },
				claude: { command: "claude", args: ["--acp"] },
			},
			defaultAgent: "gemini",
			staleTimeoutMs: 3_600_000,
			healthCheckIntervalMs: 30_000,
			circuitBreakerMaxFailures: 3,
			circuitBreakerResetMs: 60_000,
			stallTimeoutMs: 300_000,
			modelPolicy: {},
		};
		const tools = new Map<string, any>();
		const createdAdapters: any[] = [];
		const sessions = new Map<string, AcpSessionHandle>();
		const ctx = { cwd: "/ctx", ui: { setWidget: mock(), notify: mock() } };

		const m = {
			sm: {
				add: mock((handle: AcpSessionHandle) => sessions.set(handle.sessionId, handle)),
				get: mock((sessionId: string) => sessions.get(sessionId)),
				list: mock(() => Array.from(sessions.values())),
				listByAgent: mock(() => Array.from(sessions.values())),
				remove: mock(async (sessionId: string) => {
					const handle = sessions.get(sessionId);
					if (handle) {
						await handle.dispose();
						sessions.delete(sessionId);
					}
				}),
				disposeAll: mock(),
				pruneStale: mock(async () => ({ removedSessionIds: [] })),
				get size() { return sessions.size; },
			},
			ts: { create: mock(), get: mock(), update: mock(), list: mock(() => []), clear: mock(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: mock(), listFor: mock(() => []), clearFor: mock(() => 0) },
			gs: {
				getPlan: mock(), requestPlan: mock(), resolvePlan: mock(),
				getModelPolicy: mock(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: mock(), checkModel: mock(() => ({ ok: true, reason: "" })),
			},
			el: { append: mock() },
			cb: { execute: mock(async (fn: () => any) => fn()), state: "closed" },
			hm: { start: mock(), stop: mock(), register: mock() },
			co: { delegate: mock(), broadcast: mock(), compare: mock() },
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return m.sm; });
		(AcpTaskStore as any).mockImplementation(function () { return m.ts; });
		(MailboxManager as any).mockImplementation(function () { return m.mb; });
		(GovernanceStore as any).mockImplementation(function () { return m.gs; });
		(AcpEventLog as any).mockImplementation(function () { return m.el; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return m.cb; });
		(createAdapter as any).mockImplementation((agentName: string, _cfg: unknown, _config: unknown, cwd: string) => {
			const adapter = {
				agentName,
				cwd,
				spawn: mock(),
				initialize: mock(),
				newSession: mock(async () => "session-claude"),
				loadSession: mock(async (sessionId: string) => sessionId),
				prompt: mock(async () => ({ text: "response", stopReason: "end_turn", sessionId: "session-claude" })),
				setModel: mock(),
				setMode: mock(),
				cancel: mock(),
				dispose: mock(),
			};
			createdAdapters.push(adapter);
			return adapter;
		});
		(AgentCoordinator as any).mockImplementation(function () { return m.co; });

		main({ registerTool: mock((t: any) => tools.set(t.name, t)), registerCommand: mock(), on: mock() } as any);
		const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);

		await exec("acp_session_new", { agent: "claude", cwd: "/archived/project" });
		const createdHandle = sessions.get("session-claude")!;
		createdHandle.model = "claude-sonnet";
		createdHandle.mode = "plan";
		createdHandle.busy = true;
		createdHandle.lastResponseAt = ago(3_700_000);
		createdHandle.completedAt = undefined;

		// Give the health monitor time to detect staleness
		await new Promise(r => setTimeout(r, 100));
		await monitorCheckOrStale(sessions, "session-claude");

		expect(sessions.has("session-claude")).toBe(false);
		expect(archivedStore.get("session-claude")?.autoClosed).toBe(true);
		expect(archivedStore.get("session-claude")?.closeReason).toBe("stalled-no-response");

		await exec("acp_session_load", { session_id: "session-claude" });

		expect(createAdapter).toHaveBeenLastCalledWith(
			"claude",
			expect.anything(),
			expect.anything(),
			"/archived/project",
		);
		const resumedHandle = sessions.get("session-claude")!;
		expect(resumedHandle.model).toBe("claude-sonnet");
		expect(resumedHandle.mode).toBe("plan");
		expect(createdAdapters.at(-1)?.setModel).toHaveBeenCalledWith("claude-sonnet");
		expect(createdAdapters.at(-1)?.setMode).toHaveBeenCalledWith("plan");
		expect(resumedHandle.autoClosed).toBe(false);
		expect(resumedHandle.closeReason).toBeUndefined();
	});

	it("auto-closes with exact completed-idle reason after prompt completion", async () => {
		const CFG = {
			agent_servers: {
				gemini: { command: "gemini", args: ["--acp"] },
			},
			defaultAgent: "gemini",
			staleTimeoutMs: 3_600_000,
			healthCheckIntervalMs: 30_000,
			circuitBreakerMaxFailures: 3,
			circuitBreakerResetMs: 60_000,
			stallTimeoutMs: 300_000,
			modelPolicy: {},
		};
		const tools = new Map<string, any>();
		const sessions = new Map<string, AcpSessionHandle>();
		const ctx = { cwd: "/ctx", ui: { setWidget: mock(), notify: mock() } };

		const m = {
			sm: {
				add: mock((handle: AcpSessionHandle) => sessions.set(handle.sessionId, handle)),
				get: mock((sessionId: string) => sessions.get(sessionId)),
				list: mock(() => Array.from(sessions.values())),
				listByAgent: mock(() => Array.from(sessions.values())),
				remove: mock(async (sessionId: string) => {
					const handle = sessions.get(sessionId);
					if (handle) {
						await handle.dispose();
						sessions.delete(sessionId);
					}
				}),
				disposeAll: mock(),
				pruneStale: mock(async () => ({ removedSessionIds: [] })),
				get size() { return sessions.size; },
			},
			ts: { create: mock(), get: mock(), update: mock(), list: mock(() => []), clear: mock(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: mock(), listFor: mock(() => []), clearFor: mock(() => 0) },
			gs: {
				getPlan: mock(), requestPlan: mock(), resolvePlan: mock(),
				getModelPolicy: mock(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: mock(), checkModel: mock(() => ({ ok: true, reason: "" })),
			},
			el: { append: mock() },
			cb: { execute: mock(async (fn: () => any) => fn()), state: "closed" },
			co: { delegate: mock(), broadcast: mock(), compare: mock() },
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return m.sm; });
		(AcpTaskStore as any).mockImplementation(function () { return m.ts; });
		(MailboxManager as any).mockImplementation(function () { return m.mb; });
		(GovernanceStore as any).mockImplementation(function () { return m.gs; });
		(AcpEventLog as any).mockImplementation(function () { return m.el; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return m.cb; });
		(createAdapter as any).mockImplementation(() => ({
			spawn: mock(),
			initialize: mock(),
			newSession: mock(async () => "session-gemini"),
			loadSession: mock(async (sessionId: string) => sessionId),
			prompt: mock(async () => ({ text: "response", stopReason: "end_turn", sessionId: "session-gemini" })),
			setModel: mock(),
			setMode: mock(),
			cancel: mock(),
			dispose: mock(),
		}));
		(AgentCoordinator as any).mockImplementation(function () { return m.co; });

		main({ registerTool: mock((t: any) => tools.set(t.name, t)), registerCommand: mock(), on: mock() } as any);
		const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);

		const promptResult = await exec("acp_prompt", { agent: "gemini", message: "done" });
		expect(promptResult.details.sessionId).toBe("session-gemini");
		expect(sessions.get("session-gemini")?.completedAt).toBeInstanceOf(Date);

		// Mark session as completed a long time ago
		const h = sessions.get("session-gemini")!;
		h.completedAt = ago(3_700_000);

		await new Promise(r => setTimeout(r, 100));
		await monitorCheckOrStale(sessions, "session-gemini");

		expect(sessions.has("session-gemini")).toBe(false);
		expect(archivedStore.get("session-gemini")?.autoClosed).toBe(true);
		expect(archivedStore.get("session-gemini")?.closeReason).toBe("completed-idle");
	});

	it("session load can resume caller-provided existing IDs while new rejects caller-selected IDs", async () => {
		const CFG = {
			agent_servers: {
				gemini: { command: "gemini", args: ["--acp"] },
			},
			defaultAgent: "gemini",
			staleTimeoutMs: 3_600_000,
			circuitBreakerMaxFailures: 3,
			circuitBreakerResetMs: 60_000,
			stallTimeoutMs: 300_000,
			modelPolicy: {},
		};
		const tools = new Map<string, any>();
		const ctx = { cwd: "/ctx", ui: { setWidget: mock(), notify: mock() } };
		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return { add: mock(), get: mock(), list: mock(() => []), listByAgent: mock(() => []), remove: mock(), disposeAll: mock(), pruneStale: mock(async () => ({ removedSessionIds: [] })), size: 0 }; });
		(AcpTaskStore as any).mockImplementation(function () { return { create: mock(), get: mock(), update: mock(), list: mock(() => []), clear: mock(() => ({ removed: 0, remaining: 0 })) }; });
		(MailboxManager as any).mockImplementation(function () { return { send: mock(), listFor: mock(() => []), clearFor: mock(() => 0) }; });
		(GovernanceStore as any).mockImplementation(function () { return { getPlan: mock(), requestPlan: mock(), resolvePlan: mock(), getModelPolicy: mock(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: mock(), checkModel: mock(() => ({ ok: true, reason: "" })) }; });
		(AcpEventLog as any).mockImplementation(function () { return { append: mock() }; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return { execute: mock(async (fn: () => any) => fn()), state: "closed" }; });
		(createAdapter as any).mockImplementation(() => ({ spawn: mock(), initialize: mock(), newSession: mock(async () => "server-generated-id"), loadSession: mock(async (sessionId: string) => sessionId), prompt: mock(async () => ({ text: "ok", stopReason: "end_turn", sessionId: "server-generated-id" })), setModel: mock(), setMode: mock(), cancel: mock(), dispose: mock() }));
		(AgentCoordinator as any).mockImplementation(function () { return { delegate: mock(), broadcast: mock(), compare: mock() }; });
		main({ registerTool: mock((t: any) => tools.set(t.name, t)), registerCommand: mock(), on: mock() } as any);
		const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);
		const newResult = await exec("acp_session_new", { session_id: "caller-picked" });
		expect(newResult.details.error).toBe("session_id_not_allowed");
		const loadResult = await exec("acp_session_load", { session_id: "existing-session-123", agent: "gemini" });
		expect(loadResult.details.sessionId).toBe("existing-session-123");
	});
});

/** Poll the internal health monitor to detect staleness, with timeout */
async function monitorCheckOrStale(sessions: Map<string, AcpSessionHandle>, sessionId: string, maxMs = 5000): Promise<void> {
	const start = Date.now();
	while (sessions.has(sessionId) && Date.now() - start < maxMs) {
		await new Promise(r => setTimeout(r, 200));
	}
}

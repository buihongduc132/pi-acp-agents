import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HealthMonitor } from "../src/core/health-monitor.js";
import type { AcpSessionHandle } from "../src/config/types.js";

const archivedStore = new Map<string, AcpSessionHandle>();

vi.mock("../src/config/config.js", async (imp) => ({ ...await imp(), loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", async (imp) => ({ ...await imp(), SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", async (imp) => ({ ...await imp(), AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", async (imp) => ({ ...await imp(), MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", async (imp) => ({ ...await imp(), GovernanceStore: vi.fn() }));
vi.mock("../src/management/event-log.js", async (imp) => ({ ...await imp(), AcpEventLog: vi.fn() }));
vi.mock("../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class MockSessionArchiveStore {
		get = vi.fn((sessionId: string) => archivedStore.get(sessionId));
		upsert = vi.fn((session: AcpSessionHandle) => {
			archivedStore.set(session.sessionId, { ...session });
			return archivedStore.get(session.sessionId);
		});
	},
}));
vi.mock("../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime",
		tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json",
		governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl",
		sessionArchiveFile: "/mock/runtime/session-archive.json",
	}),
}));
vi.mock("../src/logger.js", () => ({ createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../src/core/circuit-breaker.js", async (imp) => ({ ...await imp(), AcpCircuitBreaker: vi.fn() }));
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
import { createAdapter } from "../src/adapter-factory.js";
import { AgentCoordinator } from "../src/coordination/coordinator.js";

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
		dispose: vi.fn(async () => {}),
	};
}

describe("ACP/Gemini session auto-close lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		archivedStore.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("auto-closes an active session after 1 hour with no new response, not based only on lastActivityAt", async () => {
		const now = new Date("2026-01-01T01:00:00.000Z");
		vi.setSystemTime(now);
		const monitor = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
		});
		const session = {
			...makeHandle("active-no-response"),
			busy: true,
			lastActivityAt: now,
			lastResponseAt: new Date(now.getTime() - 3_600_001),
		};

		monitor.register(session as any);
		const staleIds = await monitor.check();

		expect(staleIds).toContain("active-no-response");
	});

	it("auto-closes a completed session after 1 hour idle, distinct from active waiting-for-response", async () => {
		const now = new Date("2026-01-01T01:00:00.000Z");
		vi.setSystemTime(now);
		const monitor = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
		});
		const session = {
			...makeHandle("completed-idle"),
			busy: false,
			lastActivityAt: now,
			completedAt: new Date(now.getTime() - 3_600_001),
		};

		monitor.register(session as any);
		const staleIds = await monitor.check();

		expect(staleIds).toContain("completed-idle");
	});

	it("does not auto-close a busy session with no lastResponseAt yet", async () => {
		const now = new Date("2026-01-01T01:00:00.000Z");
		vi.setSystemTime(now);
		const monitor = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
		});
		const session = {
			...makeHandle("waiting-first-response"),
			busy: true,
			lastActivityAt: new Date(now.getTime() - 7_200_000),
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
		const ctx = { cwd: "/ctx", ui: { setWidget: vi.fn(), notify: vi.fn() } };

		const m = {
			sm: {
				add: vi.fn((handle: AcpSessionHandle) => sessions.set(handle.sessionId, handle)),
				get: vi.fn((sessionId: string) => sessions.get(sessionId)),
				list: vi.fn(() => Array.from(sessions.values())),
				listByAgent: vi.fn(() => Array.from(sessions.values())),
				remove: vi.fn(async (sessionId: string) => {
					const handle = sessions.get(sessionId);
					if (handle) {
						await handle.dispose();
						sessions.delete(sessionId);
					}
				}),
				disposeAll: vi.fn(),
				pruneStale: vi.fn(async () => ({ removedSessionIds: [] })),
				get size() { return sessions.size; },
			},
			ts: { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) },
			gs: {
				getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })),
			},
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" },
			hm: { start: vi.fn(), stop: vi.fn(), register: vi.fn() },
			co: { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn() },
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
				spawn: vi.fn(),
				initialize: vi.fn(),
				newSession: vi.fn(async () => "session-claude"),
				loadSession: vi.fn(async (sessionId: string) => sessionId),
				prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "session-claude" })),
				setModel: vi.fn(),
				setMode: vi.fn(),
				cancel: vi.fn(),
				dispose: vi.fn(),
			};
			createdAdapters.push(adapter);
			return adapter;
		});
		(AgentCoordinator as any).mockImplementation(function () { return m.co; });

		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
		const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);

		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		await exec("acp_session_new", { agent: "claude", cwd: "/archived/project" });
		const createdHandle = sessions.get("session-claude")!;
		createdHandle.model = "claude-sonnet";
		createdHandle.mode = "plan";
		createdHandle.busy = true;
		createdHandle.lastResponseAt = new Date("2025-12-31T22:59:59.000Z");
		createdHandle.completedAt = undefined;

		vi.setSystemTime(new Date("2026-01-01T01:00:31.000Z"));
		await vi.advanceTimersByTimeAsync(30_000);

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
		const ctx = { cwd: "/ctx", ui: { setWidget: vi.fn(), notify: vi.fn() } };

		const m = {
			sm: {
				add: vi.fn((handle: AcpSessionHandle) => sessions.set(handle.sessionId, handle)),
				get: vi.fn((sessionId: string) => sessions.get(sessionId)),
				list: vi.fn(() => Array.from(sessions.values())),
				listByAgent: vi.fn(() => Array.from(sessions.values())),
				remove: vi.fn(async (sessionId: string) => {
					const handle = sessions.get(sessionId);
					if (handle) {
						await handle.dispose();
						sessions.delete(sessionId);
					}
				}),
				disposeAll: vi.fn(),
				pruneStale: vi.fn(async () => ({ removedSessionIds: [] })),
				get size() { return sessions.size; },
			},
			ts: { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) },
			gs: {
				getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })),
			},
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" },
			co: { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn() },
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return m.sm; });
		(AcpTaskStore as any).mockImplementation(function () { return m.ts; });
		(MailboxManager as any).mockImplementation(function () { return m.mb; });
		(GovernanceStore as any).mockImplementation(function () { return m.gs; });
		(AcpEventLog as any).mockImplementation(function () { return m.el; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return m.cb; });
		(createAdapter as any).mockImplementation(() => ({
			spawn: vi.fn(),
			initialize: vi.fn(),
			newSession: vi.fn(async () => "session-gemini"),
			loadSession: vi.fn(async (sessionId: string) => sessionId),
			prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "session-gemini" })),
			setModel: vi.fn(),
			setMode: vi.fn(),
			cancel: vi.fn(),
			dispose: vi.fn(),
		}));
		(AgentCoordinator as any).mockImplementation(function () { return m.co; });

		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
		const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);

		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const promptResult = await exec("acp_prompt", { agent: "gemini", message: "done" });
		expect(promptResult.details.sessionId).toBe("session-gemini");
		expect(sessions.get("session-gemini")?.completedAt).toBeInstanceOf(Date);

		vi.setSystemTime(new Date("2026-01-01T01:00:31.000Z"));
		await vi.advanceTimersByTimeAsync(30_000);

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
		const ctx = { cwd: "/ctx", ui: { setWidget: vi.fn(), notify: vi.fn() } };
		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0 }; });
		(AcpTaskStore as any).mockImplementation(function () { return { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) }; });
		(MailboxManager as any).mockImplementation(function () { return { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) }; });
		(GovernanceStore as any).mockImplementation(function () { return { getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(), getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) }; });
		(AcpEventLog as any).mockImplementation(function () { return { append: vi.fn() }; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" }; });
		(createAdapter as any).mockImplementation(() => ({ spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "server-generated-id"), loadSession: vi.fn(async (sessionId: string) => sessionId), prompt: vi.fn(async () => ({ text: "ok", stopReason: "end_turn", sessionId: "server-generated-id" })), setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn() }));
		(AgentCoordinator as any).mockImplementation(function () { return { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn() }; });
		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
		const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);
		const newResult = await exec("acp_session_new", { session_id: "caller-picked" });
		expect(newResult.details.error).toBe("session_id_not_allowed");
		const loadResult = await exec("acp_session_load", { session_id: "existing-session-123", agent: "gemini" });
		expect(loadResult.details.sessionId).toBe("existing-session-123");
	});
});

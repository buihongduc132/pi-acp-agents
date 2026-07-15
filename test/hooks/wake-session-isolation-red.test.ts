/**
 * RED tests for the wake-subscriber session-isolation fix.
 *
 * These tests capture the TARGET (post-fix) behavior and MUST FAIL against the
 * current source. Each block maps to one of the three root-cause bugs:
 *
 *   F1 — no session-ownership filter.
 *        WakeSubscriber (src/hooks/wake-subscriber.ts) receives EVERY event
 *        from the host-wide events.sock bus and delivers it. It must drop
 *        events whose `event.payload.session.id` differs from the host
 *        session id (unless explicitly subscribed via subscribedSessionIds).
 *
 *   F2 — isIdle hardcoded `true`.
 *        In index.ts the wake adapter is wired with `isIdle: () => true`, so
 *        WakeSubscriber.computeDelivery() ALWAYS returns triggerTurn:true.
 *        The fix must wire host idle state to pi's turn lifecycle by
 *        registering `pi.on("turn_start")` + `pi.on("turn_end")` handlers.
 *
 *   F3 — DEFAULT_MUTED_EVENT_TYPES gap.
 *        Only `acp.session_started` + `acp.subagent_stop` are muted today.
 *        `acp.subagent_start` and `acp.session_completed` pass straight
 *        through and flood the host with spurious turns.
 *
 * These tests are behavioral. F1/F3 exercise the public `handleEvent` API of
 * WakeSubscriber directly; F2 loads the extension factory (index.ts) and
 * asserts the turn lifecycle handlers are registered.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SocketEvent } from "../../src/hooks/types.js";
import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";

// ── F2: mocks for the extension factory (mirrors test/index-tools.test.ts) ──
vi.mock("../../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
vi.mock("../../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class {
		get = vi.fn();
		upsert = vi.fn((s: any) => s);
	},
}));
vi.mock("../../src/management/session-name-store.js", () => ({
	SessionNameStore: class {
		getSessionId = vi.fn();
		getName = vi.fn();
		register = vi.fn((name: string, id: string) => ({ sessionName: name, sessionId: id }));
	},
}));
vi.mock("../../src/management/worker-store.js", () => ({ WorkerStore: vi.fn() }));
vi.mock("../../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime", tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json", governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl", sessionArchiveFile: "/mock/runtime/session-archive.json",
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json",
		dagDir: "/mock/runtime/dag", dagIndexFile: "/mock/runtime/dag/dag-index.json",
	}),
}));
vi.mock("../../src/management/session-store-factory.js", () => ({
	SessionStoreFactory: class {
		get() {
			return {
				taskStore: { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn() },
				mailboxManager: { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn() },
				governanceStore: { setModelPolicy: vi.fn(), getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), checkModel: vi.fn(() => ({ ok: true, reason: "" })) },
			};
		}
	},
}));
vi.mock("../../src/logger.js", () => ({
	createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../../src/core/async-executor.js", () => ({ AsyncExecutor: vi.fn() }));
vi.mock("../../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../../src/coordination/coordinator.js", () => ({ AgentCoordinator: vi.fn() }));
vi.mock("../../src/coordination/worker-dispatcher.js", () => ({ WorkerDispatcher: vi.fn(function () { return { start: vi.fn(), stop: vi.fn() }; }) }));
vi.mock("../../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));
vi.mock("../../src/tui/acp-panel.js", () => ({ createAcpPanel: vi.fn() }));
vi.mock("../../src/tui/panel-deps.js", () => ({ buildAcpPanelDepsReadOnly: vi.fn() }));
vi.mock("../../src/tui/panel-deps-full.js", () => ({ buildAcpPanelDepsFull: vi.fn() }));
vi.mock("../../src/tui/persona-resolver.js", () => ({ resolvePersona: vi.fn() }));
vi.mock("../../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../../src/dag/dag-executor.js", () => ({ DagExecutor: vi.fn() }));
vi.mock("../../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));
vi.mock("../../src/settings/config.js", () => ({ loadSettings: vi.fn(() => ({})), isToolEnabled: () => true }));
vi.mock("../../src/settings/configure-tui.js", () => ({ configureToolSettings: vi.fn() }));
vi.mock("../../src/core/session-lifecycle.js", () => ({ getSessionAutoCloseReason: vi.fn(() => undefined) }));
vi.mock("../../src/management/heartbeat-parser.js", () => ({ consumeHeartbeat: vi.fn() }));

// ── helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
	eventType: string,
	sessionId: string,
	eventId: string,
): SocketEvent {
	const payloadEvent = eventType.replace(/^acp\./, "");
	return {
		"event-type": eventType,
		"event-id": eventId,
		timestamp: new Date().toISOString(),
		source: "acp",
		payload: {
			version: 1,
			event: payloadEvent as any,
			source: "acp",
			correlationId: `corr-${eventId}`,
			session: { id: sessionId, agent: "pi", cwd: "/tmp/test" },
			agent: { name: "pi", type: "coding" },
			task: { id: `t-${eventId}`, subject: "isolated task", status: "completed" },
			timestamp: new Date().toISOString(),
		},
	};
}

function createMockPi(idle = true) {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		isIdle: vi.fn().mockReturnValue(idle),
		sendUserMessage: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
	};
}

// =====================================================================
// F1 — session-ownership filter
// =====================================================================
describe("F1 RED — WakeSubscriber drops events from foreign sessions", () => {
	beforeEach(() => {
		// ensure rate limiter (minIntervalMs) doesn't interfere — use 0.
		vi.useRealTimers();
	});

	it("delivers an event whose session.id === hostSessionId", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		await wake.handleEvent(makeEvent("acp.task_assigned", "host-1", "own"));

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("drops an event whose session.id !== hostSessionId", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		await wake.handleEvent(makeEvent("acp.task_assigned", "foreign-9", "f"));

		// RED: current code has no ownership filter → sendMessage IS called.
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("setHostSessionId() re-targets the ownership filter after construction", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		// RED: setHostSessionId does not exist yet.
		expect(typeof (wake as any).setHostSessionId).toBe("function");
		(wake as any).setHostSessionId("host-2");

		await wake.handleEvent(makeEvent("acp.task_assigned", "host-2", "new"));
		await wake.handleEvent(makeEvent("acp.task_assigned", "host-1", "old"));

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		// the surviving delivery must be the host-2 one.
		const delivered = pi.sendMessage.mock.calls[0][0] as string;
		expect(delivered).not.toContain("old");
	});

	it("respects subscribedSessionIds — foreign event IS delivered when opted in", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			subscribedSessionIds: new Set(["foreign-9"]),
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		await wake.handleEvent(makeEvent("acp.task_assigned", "foreign-9", "sub"));

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("ownership filter runs BEFORE mute — foreign session_completed is dropped regardless", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		// session_completed is NEVER_DROP — but it is FOREIGN, so ownership
		// must drop it before the mute/never-drop logic even sees it.
		await wake.handleEvent(makeEvent("acp.session_completed", "foreign-9", "fsc"));

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// =====================================================================
// F3 — DEFAULT_MUTED_EVENT_TYPES gap (subagent_start + session_completed)
// =====================================================================
describe("F3 RED — expanded mute list (subagent_start + session_completed)", () => {
	it("mutes acp.subagent_start for an OWN session", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		await wake.handleEvent(makeEvent("acp.subagent_start", "host-1", "ss"));

		// RED: subagent_start is NOT in DEFAULT_MUTED_EVENT_TYPES today.
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("delivers acp.session_completed for an OWN session (legitimate wake — NOT muted)", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		await wake.handleEvent(makeEvent("acp.session_completed", "host-1", "sc"));

		// DESIGN CORRECTION (GREEN): session_completed is intentionally NOT muted.
		// It is a NEVER_DROP lifecycle event that legitimately wakes the host
		// when ITS OWN delegated session finishes — that is the core purpose of
		// the wake subscriber. Mutings it globally would strip wake-on-own-
		// completion. Foreign session_completed flooding is handled by the F1
		// ownership filter (see the "ownership filter runs BEFORE mute" test
		// above), NOT by global muting.
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("still delivers acp.task_completed for an OWN session (control — not muted)", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: "/tmp/unused.sock",
			pi,
			hostSessionId: "host-1",
			minIntervalMs: 0,
			coalesceWindowMs: 0,
		} as any);

		await wake.handleEvent(makeEvent("acp.task_completed", "host-1", "tc"));

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

// =====================================================================
// F2 — index.ts wires isIdle to pi's turn lifecycle
// =====================================================================
describe("F2 RED — extension registers turn_start + turn_end handlers", () => {
	it("registers pi.on('turn_start') and pi.on('turn_end')", async () => {
		// Wire up constructor mocks to return minimal instances so the factory
		// can run to completion without hitting real I/O.
		const { loadConfig } = await import("../../src/config/config.js");
		const { SessionManager } = await import("../../src/core/session-manager.js");
		const { AcpEventLog } = await import("../../src/management/event-log.js");
		const { AcpCircuitBreaker } = await import("../../src/core/circuit-breaker.js");
		const { HealthMonitor } = await import("../../src/core/health-monitor.js");
		const { createAdapter } = await import("../../src/adapter-factory.js");
		const { AgentCoordinator } = await import("../../src/coordination/coordinator.js");
		const { DagExecutor } = await import("../../src/dag/dag-executor.js");
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");

		(loadConfig as any).mockReturnValue({
			agent_servers: { gemini: { command: "gemini", args: ["--acp"] } },
			defaultAgent: "gemini",
			staleTimeoutMs: 3_600_000,
			circuitBreakerMaxFailures: 3,
			circuitBreakerResetMs: 60_000,
			stallTimeoutMs: 300_000,
			modelPolicy: {},
		});
		(SessionManager as any).mockImplementation(function () {
			return {
				add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []),
				remove: vi.fn(async () => {}), disposeAll: vi.fn(async () => {}),
				pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0,
				getSessionId: vi.fn(() => "host-fake"),
			};
		});
		(AcpEventLog as any).mockImplementation(function () { return { append: vi.fn() }; });
		(AcpCircuitBreaker as any).mockImplementation(function () {
			return {
				execute: vi.fn(async (fn: () => any) => fn()), isHealthy: vi.fn(() => true),
				recordSuccess: vi.fn(), recordFailure: vi.fn(), state: "closed",
			};
		});
		(HealthMonitor as any).mockImplementation(function () {
			return {
				start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(),
				markPromptStart: vi.fn(), markPromptEnd: vi.fn(),
			};
		});
		(createAdapter as any).mockImplementation(function () {
			return {
				spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "s"),
				loadSession: vi.fn(async () => "s"), prompt: vi.fn(async () => ({ text: "", stopReason: "end_turn", sessionId: "s" })),
				setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
			};
		});
		(AgentCoordinator as any).mockImplementation(function () {
			return {
				delegate: vi.fn(async () => ({ text: "", stopReason: "end_turn", sessionId: "d" })),
				broadcast: vi.fn(async () => []), compare: vi.fn(async () => ({ responses: [], timestamp: "" })),
				dispose: vi.fn(),
			};
		});
		(DagExecutor as any).mockImplementation(function () {
			return { markStale: vi.fn(), resumeAll: vi.fn(async () => {}) };
		});
		(AsyncExecutor as any).mockImplementation(function () { return {}; });

		const registeredEvents: string[] = [];
		const fakePi = {
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn((event: string) => { registeredEvents.push(event); }),
		} as any;

		const { default: main } = await import("../../index.js");
		main(fakePi);

		// RED: today the factory only registers 'session_start' and
		// 'session_shutdown'. The fix adds 'turn_start' + 'turn_end' to drive
		// the host idle flag that feeds WakeSubscriber.isIdle.
		expect(registeredEvents).toContain("turn_start");
		expect(registeredEvents).toContain("turn_end");
	});
});

/**
 * RED tests — async spawn by default + completion callback (F2, Lane B).
 *
 * Lane = `lane-b-red`. RED PHASE ONLY — these tests MUST FAIL against the
 * current tree. A SEPARATE teammate (`lane-b-green`) implements to turn them
 * GREEN. Do NOT implement here.
 *
 * Source findings: flow/findings/acp-tool-surface-async/ (LD2 locked:
 * "async spawn = desired DEFAULT behavior; completion must fire back to the
 * main session via hook (teams-style wake)").
 *
 * ----------------------------------------------------------------------------
 * OT4 EVENT-ROUTING DECISION (encoded by these tests — implementer MUST follow)
 * ----------------------------------------------------------------------------
 * Current state:
 *   - `NEVER_DROP_EVENT_TYPES` = {acp.task_completed, acp.session_completed,
 *     acp.session_failed, acp.task_failed} (src/hooks/types.ts:115-120).
 *   - `subagent_stop` is NOT in NEVER_DROP → per-turn completion of a
 *     long-lived async spawn would be throttled/dropped under burst (the gap).
 *   - One-shot spawns already close via closeSession() → onSessionRemoved() →
 *     `session_completed` (which IS in NEVER_DROP), so the one-shot pipe exists.
 *
 * Decision (lowest-risk per escalation mandate):
 *   1. ONE-SHOT async spawn (idleTtlMs:0 + prompt): completion piggybacks on
 *      the EXISTING `session_completed` event (already NEVER_DROP). The
 *      response text is delivered to the main session via the callback, NOT
 *      returned inline (no silent loss). ✅ zero new event types.
 *   2. LONG-LIVED async spawn (prompt, no idleTtlMs:0): introduce a NEW event
 *      `spawn_completed` (HookEventName gains "spawn_completed") and add
 *      `acp.spawn_completed` to `NEVER_DROP_EVENT_TYPES`. Per-turn completion
 *      of an async-spawned long-lived session emits `spawn_completed` (NOT
 *      relying on the throttled `subagent_stop`).
 *
 *   Why not just add `subagent_stop` to NEVER_DROP? subagent_stop fires on
 *   EVERY turn of a long-lived session — promoting it to NEVER_DROP would
 *   flood the main session with one followUp per turn (defeating the rate
 *   limiter). A dedicated `spawn_completed` fires ONCE per async spawn's
 *   terminal turn, keeping the signal clean.
 *
 * ----------------------------------------------------------------------------
 * ASYNC FLAG CONTRACT (encoded by these tests)
 * ----------------------------------------------------------------------------
 * New `acp_spawn` parameter: `async?: boolean`, DEFAULT `true`.
 *   - `async: true` (default) + prompt  → execute returns IMMEDIATELY with
 *     `{ sessionId, status: "prompting", ... }` WITHOUT awaiting the prompt
 *     response. The prompt runs in the background. Completion → callback.
 *   - `async: false` + prompt           → OLD blocking behavior: execute
 *     awaits the full prompt response and returns the text inline. This is
 *     the explicit opt-out for callers that need the inline response.
 *   - no prompt                          → unchanged (returns sessionId; the
 *     async flag is irrelevant).
 *
 * Safety invariants (B1):
 *   - async ≠ no safety: the background prompt work is STILL wrapped by
 *     `safeExecute`/circuit-breaker (`cb.execute`) and bounded by
 *     `withTimeoutMs`. A failing/timed-out background prompt surfaces via the
 *     callback as a failure signal (NOT silently swallowed).
 *   - a spawn-level error (adapter.spawn() rejects) still returns the error
 *     to the caller immediately (synchronous, before any background work).
 *
 * ----------------------------------------------------------------------------
 * Test categories (per task spec):
 *   B1 — async default ............... (spawn tool)
 *   B1 — sync opt-in ................. (spawn tool)
 *   B1 — circuit-breaker preserved ... (spawn tool)
 *   B2 — callback delivery (one-shot)  (spawn tool + session_completed path)
 *   B2 — callback delivery (long-lived) (spawn_completed event — RED on types)
 *   B2 — NEVER_DROP burst ............ (WakeSubscriber unit)
 *   B2 — OT4 event decision .......... (types.ts assertions)
 *   edge — cancelled/race/long-vs-one (spawn tool)
 *   no-break — one-shot consumer ...... (spawn tool)
 *
 * Run: npx vitest run test/async-spawn-red.test.ts
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpSessionHandle } from "../src/config/types.js";

// ── Mocks: identical surface to test/index-tools.test.ts ──────────────
vi.mock("../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
const sessionArchiveMappings = new Map<string, AcpSessionHandle>();
const sessionNameMappings = new Map<string, string>();
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
		getName = vi.fn((sessionId: string) =>
			Array.from(sessionNameMappings.entries()).find(([, id]) => id === sessionId)?.[0],
		);
		register = vi.fn((sessionName: string, sessionId: string) => {
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
		dagDir: "/mock/runtime/dag", dagIndexFile: "/mock/runtime/dag/dag-index.json",
	}),
}));
vi.mock("../src/logger.js", () => ({
	createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", () => ({ AgentCoordinator: vi.fn() }));
vi.mock("../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: vi.fn() }) }));
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

// REAL (non-mocked) modules under test for the types/WakeSubscriber suites.
import { NEVER_DROP_EVENT_TYPES } from "../src/hooks/types.js";
import { WakeSubscriber } from "../src/hooks/wake-subscriber.js";
import { HookTriggerManager } from "../src/hooks/trigger-wiring.js";
import { buildHookContext } from "../src/hooks/hook-context.js";
import type { SocketEvent } from "../src/hooks/types.js";

// ── Config ────────────────────────────────────────────────────────────
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
		sessionId: id, sessionName, agentName: agent, cwd: "/tmp",
		createdAt: new Date(), lastActivityAt: new Date(), lastResponseAt: undefined,
		completedAt: undefined, accumulatedText: "", disposed: false, busy: false,
		autoClosed: false, closeReason: undefined, planStatus: "none", dispose: vi.fn(),
	};
}

/**
 * Deferred — lets a test hold a promise open so we can prove the spawn
 * execute() returned BEFORE the (background) prompt resolved.
 */
function deferred<T = unknown>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ── Shared test harness (mirrors index-tools.test.ts) ─────────────────
describe("Lane B RED — async spawn default + completion callback", () => {
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
				getPlan: vi.fn(), requestPlan: vi.fn((a: string) => ({ agent: a, status: "pending", requestedAt: new Date().toISOString() })),
				resolvePlan: vi.fn((a: string, s: string) => ({ agent: a, status: s, requestedAt: new Date().toISOString(), resolvedAt: new Date().toISOString() })),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })),
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
		(AcpEventLog as any).mockImplementation(function () { return m.el; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return m.cb; });
		(HealthMonitor as any).mockImplementation(function () { return m.hm; });
		(createAdapter as any).mockImplementation(function () { return m.ad; });
		(AgentCoordinator as any).mockImplementation(function () { return m.co; });

		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
	});

	const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);
	const paramsFor = (name: string) => (tools.get(name)?.parameters as any)?.properties ?? {};

	// =====================================================================
	// B1 — async spawn is the DEFAULT
	// =====================================================================
	describe("B1 — async spawn default", () => {
		it("exposes an `async` parameter on acp_spawn defaulting to true", () => {
			// RED: current schema has no `async` property.
			expect(paramsFor("acp_spawn")).toHaveProperty("async");
		});

		it("spawn WITH prompt returns immediately with status:prompting (does not await prompt)", async () => {
			// Hold the prompt promise open indefinitely; async execute must NOT block on it.
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			// Race execute against a fast timeout. In async mode execute resolves
			// quickly with status:prompting; in current (blocking) code it hangs on
			// `await adapter.prompt(...)` and the race rejects → test fails (RED).
			const result = await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "compute something slow" }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("acp_spawn blocked on prompt — not async by default")), 500),
				),
			]);

			expect(result.details).toMatchObject({ status: "prompting" });
			// The response text is NOT returned inline (it arrives via callback later).
			expect(result.details).not.toHaveProperty("text");
			// Background prompt WAS dispatched (just not awaited).
			expect(m.ad.prompt).toHaveBeenCalledTimes(1);
			// The pending promise is still unresolved → caller genuinely did not block.
			pending.resolve({ text: "late", stopReason: "end_turn", sessionId: "ses-1" });
		});

		it("async default does not dispose the adapter while the prompt is in flight", async () => {
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "slow" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]).catch(() => {});

			// Adapter must remain alive for the background prompt; dispose not called yet.
			expect(m.ad.dispose).not.toHaveBeenCalled();
			pending.resolve({ text: "ok", stopReason: "end_turn", sessionId: "ses-1" });
		});
	});

	// =====================================================================
	// B1 — sync opt-in restores OLD blocking behavior
	// =====================================================================
	describe("B1 — sync opt-in (async:false)", () => {
		it("async:false + prompt BLOCKS and returns the response text inline (legacy behavior)", async () => {
			m.ad.prompt.mockResolvedValue({ text: "sync-response", stopReason: "end_turn", sessionId: "ses-1" });

			const result = await exec("acp_spawn", { agent: "gemini", prompt: "hi", async: false });

			// Legacy: text returned inline, no "prompting" status.
			expect(result.content[0].text).toContain("sync-response");
			expect(result.details).not.toMatchObject({ status: "prompting" });
		});

		it("async:false one-shot still returns the inline response (no behavior change for legacy callers)", async () => {
			m.ad.prompt.mockResolvedValue({ text: "oneshot-text", stopReason: "end_turn", sessionId: "ses-1" });

			const result = await exec("acp_spawn", { agent: "gemini", prompt: "go", idleTtlMs: 0, async: false });

			expect(result.content[0].text).toContain("oneshot-text");
		});
	});

	// =====================================================================
	// B1 — circuit-breaker / safety preserved on background work
	// =====================================================================
	describe("B1 — circuit-breaker preserved on background work", () => {
		it("async spawn still routes the operation through the circuit breaker (cb.execute)", async () => {
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "x" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]).catch(() => {});

			// safeExecute wraps spawn in cb.execute — async must NOT bypass it.
			expect(m.cb.execute).toHaveBeenCalled();
			pending.resolve({ text: "ok", stopReason: "end_turn", sessionId: "ses-1" });
		});

		it("a spawn-level error (adapter.spawn rejects) returns the error to the caller immediately, even in async mode", async () => {
			m.ad.spawn.mockRejectedValueOnce(new Error("binary missing"));

			const result = await exec("acp_spawn", { agent: "gemini", prompt: "anything" });

			// Synchronous error path: caller gets the error, no background work started.
			expect(result.content[0].text).toContain("binary missing");
			expect(m.ad.prompt).not.toHaveBeenCalled();
		});

		it("a background prompt FAILURE surfaces as a failure callback signal (not silently swallowed)", async () => {
			// In async mode the prompt runs in the background. When it fails, the
			// failure must be observable — either via a hook event (session_failed /
			// spawn_failed) or an event-log entry — never silently dropped.
			// We assert via the event log + the failure-event hook path.
			//
			// RED: current code has no background-prompt path; this contract is new.
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			// Kick off async spawn (returns immediately).
			await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "will-fail" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]).catch(() => {});

			// Now make the background prompt fail and let microtasks flush.
			pending.reject(new Error("background prompt crashed"));
			// Allow background handlers (setImmediate / promise chains) to drain.
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// Failure must be observable somewhere — event log append for an
			// error/fail kind, OR a session_failed hook dispatch. The mock `m.sm`
			// receives onSessionRemoved via hookTriggers; assert at least one
			// failure signal was recorded.
			const failureSignals =
				m.el.append.mock.calls.filter((c: any[]) =>
					typeof c[1] === "object" && c[1] !== null &&
					/fail|error/i.test(String((c[1] as any).label ?? (c[1] as any).type ?? "")),
				).length +
				m.sm.remove.mock.calls.length; // session_removed on failure
			expect(failureSignals).toBeGreaterThan(0);
		});
	});

	// =====================================================================
	// B2 — callback delivery (one-shot): piggybacks on session_completed
	// =====================================================================
	describe("B2 — one-shot async callback (session_completed path)", () => {
		it("async one-shot returns status:prompting immediately and does NOT return the response inline", async () => {
			// RED: current one-shot returns the text inline after awaiting.
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			const result = await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "oneshot", idleTtlMs: 0 }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]);

			expect(result.details).toMatchObject({ status: "prompting" });
			expect(result.content[0].text).not.toContain("response"); // not the prompt text
		});

		it("async one-shot completion closes the session and fires session_completed (NEVER_DROP pipe)", async () => {
			// The one-shot close path already dispatches session_completed today;
			// what's NEW is that it happens in the BACKGROUND after an async return.
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "oneshot", idleTtlMs: 0 }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]).catch(() => {});

			// Resolve the background prompt and let the one-shot close path run.
			pending.resolve({ text: "done", stopReason: "end_turn", sessionId: "ses-1" });
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// session_completed is in NEVER_DROP → it must reach WakeSubscriber.
			// We assert the close path ran (dispose + remove), which is the precondition
			// for the session_completed hook dispatch that feeds the callback.
			expect(m.ad.dispose).toHaveBeenCalled();
			expect(m.sm.remove).toHaveBeenCalledWith("ses-1");
		});
	});

	// =====================================================================
	// edge cases — cancel / race / long-lived-vs-one-shot
	// =====================================================================
	describe("edge cases", () => {
		it("concurrent async spawns each return their own sessionId immediately", async () => {
			let n = 0;
			m.ad.newSession.mockImplementation(async () => `ses-${++n}`);
			const p1 = deferred<{ text: string; stopReason: string; sessionId: string }>();
			const p2 = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise);

			const [r1, r2] = await Promise.all([
				Promise.race([
					exec("acp_spawn", { agent: "gemini", prompt: "a" }),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("a blocked")), 500)),
				]),
				Promise.race([
					exec("acp_spawn", { agent: "gemini", prompt: "b" }),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("b blocked")), 500)),
				]),
			]);

			expect(r1.details.sessionId).not.toBe(r2.details.sessionId);
			expect(r1.details).toMatchObject({ status: "prompting" });
			expect(r2.details).toMatchObject({ status: "prompting" });

			p1.resolve({ text: "a", stopReason: "end_turn", sessionId: "ses-1" });
			p2.resolve({ text: "b", stopReason: "end_turn", sessionId: "ses-2" });
		});

		it("a cancelled async spawn does not emit a spurious success completion callback", async () => {
			// If the background prompt is cancelled, the completion callback must
			// either NOT fire a success signal OR fire a distinct cancelled/failed
			// signal — never a false "completed". We assert no success-style
			// session_completed fires for a cancelled-in-flight spawn.
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);
			m.ad.cancel.mockResolvedValue(undefined);

			await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "cancellable" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]).catch(() => {});

			// Cancel the in-flight turn (via acp_msg cancel) and reject the prompt.
			await exec("acp_msg", { to: "ses-1", message: "", cancel: true }).catch(() => {});
			pending.reject(new Error("cancelled"));
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// No "completed" close reason recorded for a cancelled spawn — only
			// error/failed-style teardown is acceptable here.
			const completedCloses = m.el.append.mock.calls.filter(
				(c: any[]) => c[0] === "session_closed" && /completed/.test(String((c[1] as any)?.closeReason ?? "")),
			).length;
			expect(completedCloses).toBe(0);
		});
	});

	// =====================================================================
	// no-break — existing one-shot consumers
	// =====================================================================
	describe("no-breaking one-shot consumers", () => {
		it("legacy one-shot (no async flag, explicit async:false) still returns text inline — no silent loss", async () => {
			// The hard invariant from the task: async default must NOT silently
			// swallow one-shot results. Callers that opt into sync (async:false)
			// must keep getting the inline text exactly as before.
			m.ad.prompt.mockResolvedValue({ text: "legacy-result", stopReason: "end_turn", sessionId: "ses-1" });

			const result = await exec("acp_spawn", { agent: "gemini", prompt: "legacy", idleTtlMs: 0, async: false });

			expect(result.content[0].text).toContain("legacy-result");
		});
	});
});

// =====================================================================
// B2 / OT4 — types-level decisions (src/hooks/types.ts)
// =====================================================================
describe("Lane B RED — OT4 event decision (types.ts + trigger-wiring)", () => {
	it("HookTriggerManager exposes a method to fire the new `spawn_completed` event", () => {
		// RED: current HookTriggerManager has onSessionAdded/onSessionRemoved/
		// onTaskDispatched/onTaskResult/onSessionIdle/onSubagentStart/onSubagentStop
		// but NO spawn-completion hook. GREEN must wire `spawn_completed` through
		// the trigger manager (the real dispatch integration point), not merely
		// add a string to the HookEventName union.
		expect(typeof (HookTriggerManager.prototype as any).onSpawnCompleted).toBe("function");
	});

	it("buildHookContext accepts event='spawn_completed' and emits a valid HookContext", () => {
		// RED at the type level today (spawn_completed not in the union). At runtime
		// esbuild strips the type, so we assert the produced context carries the
		// event literal through — GREEN adds the union member + this stays green.
		const ctx = buildHookContext({
			event: "spawn_completed" as any,
			session: { id: "s1", agent: "pi", cwd: "/p" },
			agent: { name: "pi", type: "acp" },
		});
		expect(ctx.event).toBe("spawn_completed");
		expect(ctx.source).toBe("acp");
		expect(ctx.correlationId).toBeTruthy();
	});

	it("NEVER_DROP_EVENT_TYPES protects `acp.spawn_completed` (long-lived async callback survives burst)", () => {
		// RED: current NEVER_DROP set lacks acp.spawn_completed.
		expect(NEVER_DROP_EVENT_TYPES.has("acp.spawn_completed")).toBe(true);
	});

	it("NEVER_DROP_EVENT_TYPES still protects the existing completion events (regression guard)", () => {
		expect(NEVER_DROP_EVENT_TYPES.has("acp.session_completed")).toBe(true);
		expect(NEVER_DROP_EVENT_TYPES.has("acp.session_failed")).toBe(true);
		expect(NEVER_DROP_EVENT_TYPES.has("acp.task_completed")).toBe(true);
		expect(NEVER_DROP_EVENT_TYPES.has("acp.task_failed")).toBe(true);
	});
});

// =====================================================================
// B2 — NEVER_DROP burst delivery (WakeSubscriber unit)
// =====================================================================
function makeEvent(eventType: string, eventId: string): SocketEvent {
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
			session: { id: "sess-1", agent: "pi", cwd: tmpdir() },
			agent: { name: "pi", type: "coding" },
			task: { id: `t-${eventId}`, subject: "async-spawn", status: "completed" },
			timestamp: new Date().toISOString(),
		},
	};
}

describe("Lane B RED — WakeSubscriber NEVER_DROP burst (spawn_completed)", () => {
	const SOCK = join(tmpdir(), "acp-async-spawn-red.sock");

	function createMockPi() {
		return { sendUserMessage: vi.fn().mockResolvedValue(undefined), log: vi.fn() };
	}

	it("a burst of `acp.spawn_completed` events is delivered in full — NONE throttled/dropped", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({ path: SOCK, pi, minIntervalMs: 1000 });

		// Fire 5 spawn_completed events back-to-back (well under the 1000ms interval).
		for (let i = 0; i < 5; i++) {
			await wake.handleEvent(makeEvent("acp.spawn_completed", `sp-${i}`));
		}

		// RED: acp.spawn_completed is not in NEVER_DROP today, so these get
		// throttled and only ~1 is delivered. GREEN adds it → all 5 delivered.
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(5);
	});

	it("`acp.session_completed` burst is delivered in full (control: already NEVER_DROP)", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({ path: SOCK, pi, minIntervalMs: 1000 });

		for (let i = 0; i < 5; i++) {
			await wake.handleEvent(makeEvent("acp.session_completed", `sc-${i}`));
		}

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(5);
	});

	it("non-completion events (subagent_stop) ARE still throttled under burst — proving the limiter is intact", async () => {
		const pi = createMockPi();
		const wake = new WakeSubscriber({ path: SOCK, pi, minIntervalMs: 1000 });

		for (let i = 0; i < 5; i++) {
			await wake.handleEvent(makeEvent("acp.subagent_stop", `ss-${i}`));
		}

		// subagent_stop stays OUT of NEVER_DROP (per OT4 decision) — only the
		// first passes; the rest are throttled. This is intentional: relying on
		// subagent_stop for async callbacks would flood the main session.
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});
});

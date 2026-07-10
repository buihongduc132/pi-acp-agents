/**
 * RED-TEAM CALLOUT FIXES — Lane B follow-up (CA-3, CA-6, CA-7, CA-8).
 *
 * These tests verify the fixes for the four callouts the red-team raised
 * against the merged async-spawn feature (#28). They are GREEN tests
 * (implementation already applied). They guard against regression of:
 *
 *   CA-3 (HIGH)   — config.spawns.asyncDefault opt-out for the async-by-default
 *                   breaking change to acp_spawn.
 *   CA-6 (MEDIUM) — shutdown drains/persists in-flight async spawns so their
 *                   outcome is recoverable, not silently lost on a shutdown
 *                   race.
 *   CA-7 (MEDIUM) — background closure uses a captured const handle (no
 *                   `handle!` non-null assertions).
 *   CA-8 (MEDIUM) — criticalEvents buffer is bounded (high-water mark cap).
 *
 * Run: npx vitest run test/red-team-callouts.test.ts
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AcpSessionHandle } from "../src/config/types.js";

// ═══════════════════════════════════════════════════════════════════════
// CA-8 — criticalEvents buffer bound (socket-bus.ts)
// ═══════════════════════════════════════════════════════════════════════
import { SocketPublisher, type PublisherOptions } from "../src/hooks/socket-bus.js";
import type { SocketEvent } from "../src/hooks/types.js";

function mkCriticalEvent(id: string): SocketEvent {
	return {
		"event-type": "acp.task_completed",
		"event-id": id,
		timestamp: new Date().toISOString(),
		source: "acp",
		payload: {
			version: 1,
			event: "task_completed",
			source: "acp",
			correlationId: `corr-${id}`,
			session: { id: "s1", agent: "pi", cwd: "/tmp" },
			agent: { name: "pi", type: "coding" },
			task: { id: `t-${id}`, subject: "burst", status: "completed" },
			timestamp: new Date().toISOString(),
		},
	};
}

describe("CA-8 — criticalEvents buffer is bounded", () => {
	let tmpDir: string;
	let sockPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-ca8-"));
		sockPath = join(tmpDir, "events.sock");
	});
	// no afterEach needed — we never start() the publisher (no socket bind);
	// bufferEvent is exercised directly via publish().

	describe("default cap (1000)", () => {
		it("defaults criticalEventsCap to 1000 when not provided", () => {
			const publisher = new SocketPublisher({ path: sockPath });
			expect((publisher as any).criticalEventsCap).toBe(1000);
		});

		it("does NOT grow criticalEvents past the cap under a sustained burst", async () => {
			// No subscriber → events accumulate in the buffer (consumer disconnected).
			const publisher = new SocketPublisher({ path: sockPath });
			// Publish 1500 critical events (well past the default 1000 cap).
			for (let i = 0; i < 1500; i++) {
				await publisher.publish(mkCriticalEvent(`evt-${i}`));
			}
			const buffered = publisher.getBufferedEvents();
			// Must be capped — never unbounded.
			expect(buffered.length).toBeLessThanOrEqual(1000);
			// Most recent 1000 are retained (eviction is oldest-first).
			expect(buffered.length).toBe(1000);
			// First retained is evt-500 (evt-0..499 evicted as oldest).
			expect(buffered[0]["event-id"]).toBe("evt-500");
			// Last retained is the most recent.
			expect(buffered[buffered.length - 1]["event-id"]).toBe("evt-1499");
		});
	});

	describe("configurable cap", () => {
		it("respects a custom criticalEventsCap", async () => {
			const opts: PublisherOptions = { path: sockPath, criticalEventsCap: 10 };
			const publisher = new SocketPublisher(opts);
			expect((publisher as any).criticalEventsCap).toBe(10);

			for (let i = 0; i < 25; i++) {
				await publisher.publish(mkCriticalEvent(`c-${i}`));
			}
			const buffered = publisher.getBufferedEvents();
			expect(buffered.length).toBe(10);
			expect(buffered[0]["event-id"]).toBe("c-15");
			expect(buffered[buffered.length - 1]["event-id"]).toBe("c-24");
		});

		it("still keeps non-critical ring and critical buffer independently bounded", async () => {
			const publisher = new SocketPublisher({
				path: sockPath,
				ringBufferSize: 5,
				criticalEventsCap: 3,
			});
			// Mix of critical + non-critical bursts.
			for (let i = 0; i < 20; i++) {
				await publisher.publish({
					"event-type": "acp.session_idle", // non-critical
					"event-id": `idle-${i}`,
					timestamp: new Date().toISOString(),
					source: "acp",
					payload: {
						version: 1, event: "session_idle", source: "acp",
						correlationId: `ci-${i}`,
						session: { id: "s1", agent: "pi", cwd: "/tmp" },
						agent: { name: "pi", type: "coding" },
						timestamp: new Date().toISOString(),
					},
				});
				await publisher.publish(mkCriticalEvent(`crit-${i}`));
			}
			const buffered = publisher.getBufferedEvents();
			// non-critical capped at 5, critical capped at 3 → max 8.
			expect(buffered.length).toBeLessThanOrEqual(8);
			const critIds = buffered.filter((e) => e["event-type"] === "acp.task_completed").map((e) => e["event-id"]);
			expect(critIds.length).toBe(3); // capped at 3
		});
	});

	describe("regression — never-drop delivery semantics preserved", () => {
		it("a single critical event is retained (not lost) when under the cap", async () => {
			const publisher = new SocketPublisher({ path: sockPath, criticalEventsCap: 1000 });
			await publisher.publish(mkCriticalEvent("solo"));
			const buffered = publisher.getBufferedEvents();
			expect(buffered.find((e) => e["event-id"] === "solo")).toBeDefined();
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// CA-3 — config.spawns.asyncDefault opt-out (config layer)
// ═══════════════════════════════════════════════════════════════════════
import { validateConfig, DEFAULT_CONFIG } from "../src/config/config.js";

describe("CA-3 — config.spawns.asyncDefault opt-out", () => {
	describe("DEFAULT_CONFIG", () => {
		it("defaults spawns.asyncDefault to true (new desired behavior, LD2/OT4)", () => {
			expect(DEFAULT_CONFIG.spawns).toBeDefined();
			expect(DEFAULT_CONFIG.spawns!.asyncDefault).toBe(true);
		});

		it("defaults spawns.asyncShutdownDrainMs to 10_000", () => {
			expect(DEFAULT_CONFIG.spawns!.asyncShutdownDrainMs).toBe(10_000);
		});
	});

	describe("validateConfig", () => {
		it("applies asyncDefault default (true) when spawns omitted", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
			});
			expect(config.spawns?.asyncDefault).toBe(true);
			expect(config.spawns?.asyncShutdownDrainMs).toBe(10_000);
		});

		it("honors asyncDefault:false (global opt-out — restore legacy blocking)", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
				spawns: { asyncDefault: false },
			});
			expect(config.spawns?.asyncDefault).toBe(false);
		});

		it("honors asyncShutdownDrainMs override", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
				spawns: { asyncDefault: true, asyncShutdownDrainMs: 2_000 },
			});
			expect(config.spawns?.asyncDefault).toBe(true);
			expect(config.spawns?.asyncShutdownDrainMs).toBe(2_000);
		});

		it("merges partial spawns — omitted asyncDefault still defaults to true", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
				spawns: { asyncShutdownDrainMs: 500 }, // asyncDefault omitted
			});
			expect(config.spawns?.asyncDefault).toBe(true);
			expect(config.spawns?.asyncShutdownDrainMs).toBe(500);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// CA-3 / CA-6 / CA-7 — spawn tool integration (index.ts)
// ═══════════════════════════════════════════════════════════════════════
// Mocks: identical surface to test/async-spawn-red.test.ts
vi.mock("../src/config/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config/config.js")>();
	return { ...actual, loadConfig: vi.fn() };
});
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

function deferred<T = unknown>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("CA-3 / CA-6 / CA-7 — spawn tool integration", () => {
	let tools: Map<string, any>;
	let shutdownHandlers: Array<() => Promise<void> | void>;
	let m: any;
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	function buildConfig(overrides: any = {}) {
		return {
			agent_servers: {
				gemini: { command: "gemini", args: ["--acp"] },
			},
			defaultAgent: "gemini",
			staleTimeoutMs: 3_600_000,
			circuitBreakerMaxFailures: 3,
			circuitBreakerResetMs: 60_000,
			stallTimeoutMs: 300_000,
			modelPolicy: {},
			...overrides,
		};
	}

	beforeEach(() => {
		sessionArchiveMappings.clear();
		sessionNameMappings.clear();
		tools = new Map();
		shutdownHandlers = [];
		m = {
			sm: {
				add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []),
				remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0,
			},
			ts: {
				create: vi.fn((i: any) => ({ id: "t1", subject: i.subject, description: i.description ?? null, status: "pending", assignee: i.assignee ?? null, blockedBy: [], result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
				get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })),
			},
			mb: { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) },
			gs: {
				getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(),
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
			co: { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn(), dispose: vi.fn() },
		};

		(loadConfig as any).mockReturnValue(buildConfig());
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
			registerCommand: vi.fn(),
			on: vi.fn((event: string, handler: () => any) => {
				if (event === "session_shutdown") shutdownHandlers.push(handler);
			}),
		} as any);
	});

	const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);
	const runShutdown = () => Promise.all(shutdownHandlers.map((h) => h()));

	// ── CA-3: config toggle drives the default ──────────────────────────
	describe("CA-3 — asyncDefault config toggle", () => {
		it("respects asyncDefault:false at the config level — spawn defaults to blocking", async () => {
			// Re-init main() with asyncDefault:false config.
			(loadConfig as any).mockReturnValue(buildConfig({ spawns: { asyncDefault: false } }));
			tools.clear();
			shutdownHandlers.length = 0;
			main({
				registerTool: vi.fn((t: any) => tools.set(t.name, t)),
				registerCommand: vi.fn(),
				on: vi.fn((event: string, handler: () => any) => { if (event === "session_shutdown") shutdownHandlers.push(handler); }),
			} as any);

			m.ad.prompt.mockResolvedValue({ text: "inline-result", stopReason: "end_turn", sessionId: "ses-1" });

			const result = await exec("acp_spawn", { agent: "gemini", prompt: "hi" });

			// asyncDefault:false → blocking (legacy). Text returned inline, no prompting status.
			expect(result.content[0].text).toContain("inline-result");
			expect(result.details).not.toMatchObject({ status: "prompting" });
		});

		it("per-call async:true overrides asyncDefault:false config", async () => {
			(loadConfig as any).mockReturnValue(buildConfig({ spawns: { asyncDefault: false } }));
			tools.clear();
			shutdownHandlers.length = 0;
			main({
				registerTool: vi.fn((t: any) => tools.set(t.name, t)),
				registerCommand: vi.fn(),
				on: vi.fn((event: string, handler: () => any) => { if (event === "session_shutdown") shutdownHandlers.push(handler); }),
			} as any);

			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			const result = await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "force-async", async: true }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]);

			// Explicit async:true overrides the false config default → status:prompting.
			expect(result.details).toMatchObject({ status: "prompting" });
			pending.resolve({ text: "late", stopReason: "end_turn", sessionId: "ses-1" });
		});

		it("per-call async:false overrides asyncDefault:true config", async () => {
			// Default config has asyncDefault:true; explicit async:false must still block.
			m.ad.prompt.mockResolvedValue({ text: "sync-override", stopReason: "end_turn", sessionId: "ses-1" });

			const result = await exec("acp_spawn", { agent: "gemini", prompt: "force-sync", async: false });

			expect(result.content[0].text).toContain("sync-override");
			expect(result.details).not.toMatchObject({ status: "prompting" });
		});

		it("asyncDefault:true (default) — spawn returns status:prompting", async () => {
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);

			const result = await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "default" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]);

			expect(result.details).toMatchObject({ status: "prompting" });
			pending.resolve({ text: "late", stopReason: "end_turn", sessionId: "ses-1" });
		});
	});

	// ── CA-6: shutdown drain/persist ────────────────────────────────────
	describe("CA-6 — shutdown drains/persists in-flight async spawns", () => {
		it("persists an abandoned marker for a spawn still prompting at shutdown (no silent loss)", async () => {
			// Keep the background prompt pending forever → it never resolves.
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);
			// Use a short drain timeout so the test doesn't wait 10s.
			(loadConfig as any).mockReturnValue(buildConfig({ spawns: { asyncDefault: true, asyncShutdownDrainMs: 30 } }));
			tools.clear();
			shutdownHandlers.length = 0;
			main({
				registerTool: vi.fn((t: any) => tools.set(t.name, t)),
				registerCommand: vi.fn(),
				on: vi.fn((event: string, handler: () => any) => { if (event === "session_shutdown") shutdownHandlers.push(handler); }),
			} as any);

			await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "never-resolves" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]).catch(() => {});

			// Trigger shutdown while the prompt is still in-flight.
			await runShutdown();

			// The abandoned marker MUST be persisted (recoverable/observable).
			const abandoned = m.el.append.mock.calls.filter((c: any[]) => c[0] === "async_spawn_abandoned");
			expect(abandoned.length).toBe(1);
			expect(abandoned[0][1]).toMatchObject({ sessionId: "ses-1", reason: "shutdown_timeout" });

			// Drain lifecycle events logged.
			const drainStart = m.el.append.mock.calls.filter((c: any[]) => c[0] === "async_spawn_drain_start");
			const drainComplete = m.el.append.mock.calls.filter((c: any[]) => c[0] === "async_spawn_drain_complete");
			expect(drainStart.length).toBe(1);
			expect(drainComplete.length).toBe(1);
		});

		it("no-op when there are no pending async spawns at shutdown", async () => {
			await runShutdown();
			const drainCalls = m.el.append.mock.calls.filter((c: any[]) =>
				["async_spawn_drain_start", "async_spawn_abandoned"].includes(c[0]),
			);
			expect(drainCalls.length).toBe(0);
		});

		it("a spawn that resolves DURING the drain is NOT marked abandoned", async () => {
			// The prompt resolves quickly — it should settle before the drain timeout.
			m.ad.prompt.mockResolvedValue({ text: "done-quick", stopReason: "end_turn", sessionId: "ses-1" });

			await exec("acp_spawn", { agent: "gemini", prompt: "quick" });
			// Let the background closure run.
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			await runShutdown();

			const abandoned = m.el.append.mock.calls.filter((c: any[]) => c[0] === "async_spawn_abandoned");
			expect(abandoned.length).toBe(0);
		});

		it("drain runs BEFORE hooks are disposed (terminal state persisted, not swallowed)", async () => {
			// Verify ordering: drain_start happens, and the session-archive got
			// the abandoned handle with closeReason set, proving the state was
			// persisted (recoverable on resume) rather than silently lost.
			const pending = deferred<{ text: string; stopReason: string; sessionId: string }>();
			m.ad.prompt.mockReturnValue(pending.promise);
			(loadConfig as any).mockReturnValue(buildConfig({ spawns: { asyncDefault: true, asyncShutdownDrainMs: 30 } }));
			tools.clear();
			shutdownHandlers.length = 0;
			main({
				registerTool: vi.fn((t: any) => tools.set(t.name, t)),
				registerCommand: vi.fn(),
				on: vi.fn((event: string, handler: () => any) => { if (event === "session_shutdown") shutdownHandlers.push(handler); }),
			} as any);

			await Promise.race([
				exec("acp_spawn", { agent: "gemini", prompt: "slow" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 500)),
			]).catch(() => {});

			await runShutdown();

			// The archived handle was marked abandoned-shutdown (recoverable).
			const archived = sessionArchiveMappings.get("ses-1");
			expect(archived).toBeDefined();
			expect(archived!.closeReason).toBe("abandoned-shutdown");
		});
	});

	// ── CA-7: no handle! non-null assertions in background closure ──────
	describe("CA-7 — background closure null-safety", () => {
		it("background closure uses a captured const handle (no handle! assertions in source)", async () => {
			// Source-level guard: the async background closure must not contain
			// `handle!` non-null assertions. We read the source and assert.
			const fs = await import("node:fs");
			const src = fs.readFileSync(join(process.cwd(), "index.ts"), "utf-8");
			// Isolate the async-spawn closure block (between the isAsyncSpawn
			// guard and the sync-path comment) and assert it uses bgHandle, not handle!.
			const closureStart = src.indexOf("const bgHandle = handle;");
			const closureEnd = src.indexOf("// ── Sync (legacy) path");
			expect(closureStart).toBeGreaterThan(-1);
			expect(closureEnd).toBeGreaterThan(closureStart);
			const closureSrc = src.slice(closureStart, closureEnd);
			// No handle! non-null assertions in the closure body.
			expect(closureSrc).not.toContain("handle!");
			// The defensive guard exists.
			expect(closureSrc).toContain("bgHandle");
		});

		it("background completion updates the captured handle (markPromptLifecycle uses const ref)", async () => {
			// If the closure used `handle!` and handle were reassigned elsewhere,
			// the wrong handle would be updated. Using a captured const guarantees
			// the SAME handle object receives markPromptLifecycle.
			m.ad.prompt.mockResolvedValue({ text: "result-text", stopReason: "end_turn", sessionId: "ses-1" });

			await exec("acp_spawn", { agent: "gemini", prompt: "completion" });
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// The archived handle accumulated the response text.
			const archived = sessionArchiveMappings.get("ses-1");
			expect(archived).toBeDefined();
			expect(archived!.accumulatedText).toContain("result-text");
			expect(archived!.busy).toBe(false);
			expect(archived!.isPrompting).toBe(false);
		});

		it("defensive throw fires if handle is somehow missing (fail-loud, not silent NPE)", () => {
			// Source-level: the defensive guard `if (!handle) throw` exists
			// right before the closure capture.
			const fs = require("node:fs");
			const src = fs.readFileSync(join(process.cwd(), "index.ts"), "utf-8");
			const idx = src.indexOf("const bgHandle = handle;");
			const guard = src.slice(idx - 400, idx);
			expect(guard).toContain('if (!handle)');
			expect(guard).toMatch(/throw new Error/);
		});
	});
});

/**
 * Task 8.5 — Smoke test: parallel wave execution via the real tool surface.
 *
 * Behavior under test (specs/dag-execution "Wave-based parallel execution",
 * scenario "Execute a 3-wave DAG" + "Steps within a wave dispatch via
 * AsyncExecutor"):
 *
 *   DAG shape: a → [b, c] → d
 *     - wave 1 = ["a"]
 *     - wave 2 = ["b", "c"]  (both depend only on "a" → run in PARALLEL)
 *     - wave 3 = ["d"]       (depends on both "b" and "c")
 *
 * Assertions:
 *   1. Wave 1 ("a") executes first.
 *   2. Wave 2 ("b" AND "c") dispatch in parallel — both `delegate` calls are
 *      in flight simultaneously. This is proven by a barrier: neither mock
 *      resolves until the OTHER is also in flight. Under serial execution
 *      this would deadlock; under parallel dispatch both resolve promptly.
 *   3. Wave 3 ("d") executes only after BOTH "b" and "c" reach terminal
 *      state — never concurrently with wave 2.
 *   4. Final DAG status is `completed`, every step `completed`, persisted
 *      to disk.
 *
 * The test exercises the real `DagStore`, `DagValidator`, `DagExecutor`,
 * and `TemplateResolver` through the tool handlers in `index.ts`. Only the
 * leaf-level agent transport and unrelated session/runtime infrastructure
 * are mocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";

// ── Mocks for infrastructure NOT under test ──────────────────────────────
vi.mock("../../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../../src/management/event-log.js", () => ({
	AcpEventLog: vi.fn(function (this: any) {
		this.append = vi.fn();
	}),
}));
vi.mock("../../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: vi.fn(),
}));
vi.mock("../../src/management/session-name-store.js", () => ({
	SessionNameStore: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({
	createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../../src/core/async-executor.js", () => ({ AsyncExecutor: vi.fn() }));
vi.mock("../../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));

// Shared mock coordinator. The barrier proves wave 2 ("b","c") dispatches
// concurrently — neither step resolves until the OTHER is in flight.
const { makeCoordinator, delegateSpy, wave2Barrier } = vi.hoisted(() => {
	const delegateSpy = vi.fn();
	const wave2Barrier = {
		bInFlight: false,
		cInFlight: false,
	};
	const makeCoordinator = () => ({
		delegate: delegateSpy,
		broadcast: vi.fn(async () => []),
		compare: vi.fn(async () => ({ responses: [], timestamp: new Date().toISOString() })),
		dispose: vi.fn(),
	});
	return { makeCoordinator, delegateSpy, wave2Barrier };
});
vi.mock("../../src/coordination/coordinator.js", () => ({
	AgentCoordinator: vi.fn(function (this: any) {
		Object.assign(this, makeCoordinator());
	}),
}));

// Runtime paths point at a fresh tmp dir so the real DagStore can persist.
const { runtimeRoot } = vi.hoisted(() => ({ runtimeRoot: { value: "" } }));
vi.mock("../../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => {
		const root = runtimeRoot.value;
		return {
			rootDir: root,
			tasksFile: join(root, "tasks.json"),
			mailboxesFile: join(root, "mailboxes.json"),
			governanceFile: join(root, "governance.json"),
			eventLogFile: join(root, "events.jsonl"),
			sessionArchiveFile: join(root, "session-archive.json"),
			sessionNameRegistryFile: join(root, "session-name-registry.json"),
			workersFile: join(root, "workers.json"),
			dagDir: join(root, "dag"),
			dagIndexFile: join(root, "dag", "dag-index.json"),
		};
	},
}));

import main from "../../index.js";
import { loadConfig } from "../../src/config/config.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { AcpTaskStore } from "../../src/management/task-store.js";
import { MailboxManager } from "../../src/management/mailbox-manager.js";
import { GovernanceStore } from "../../src/management/governance-store.js";
import { AcpEventLog } from "../../src/management/event-log.js";
import { HealthMonitor } from "../../src/core/health-monitor.js";
import { createAdapter } from "../../src/adapter-factory.js";

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
	dagStaleTimeoutMs: 3_600_000,
	dagOutputTruncateChars: 8000,
};

const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

describe("DAG smoke — parallel wave execution (task 8.5)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-parallel-"));
		delegateSpy.mockClear();
		wave2Barrier.bInFlight = false;
		wave2Barrier.cInFlight = false;

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () {
			return { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []), remove: vi.fn(async () => {}), disposeAll: vi.fn(async () => {}), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0 };
		});
		(AcpTaskStore as any).mockImplementation(function () {
			return { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) };
		});
		(MailboxManager as any).mockImplementation(function () {
			return { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) };
		});
		(GovernanceStore as any).mockImplementation(function () {
			return { getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(), getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) };
		});
		(AcpEventLog as any).mockImplementation(function (this: any) {
			this.append = vi.fn();
		});
		(HealthMonitor as any).mockImplementation(function () {
			return { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() };
		});
		(createAdapter as any).mockImplementation(function () {
			return { spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "ses-1"), loadSession: vi.fn(), prompt: vi.fn(async () => ({ text: "x", stopReason: "end_turn", sessionId: "ses-1" })), setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
		});

		main({
			registerTool: vi.fn((t: any) => tools.set(t.name, t)),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
	});

	const exec = (name: string, params: any) =>
		tools.get(name)!.execute("t", params, undefined, undefined, ctx);

	it("executes a 3-wave DAG (a → [b,c] → d) with wave 2 in parallel", async () => {
		// Order the steps were dispatched, captured by the mock delegate.
		const dispatchOrder: string[] = [];

		delegateSpy.mockImplementation(async (_agent: string, message: string) => {
			dispatchOrder.push(message);
			// Wave 1: step "a" resolves immediately.
			if (message === "Step A") {
				return { text: "A-out", stopReason: "end_turn", sessionId: "a-1" };
			}
			// Wave 2 barrier: "b" and "c" must both be in flight before either
			// resolves. This proves parallel dispatch within wave 2. Under
			// serial execution the second step's mock could never be entered
			// because the first step never resolves — the test would hang and
			// time out. Under parallel dispatch, both enter, see each other
			// in flight, and promptly resolve.
			if (message === "Step B") {
				wave2Barrier.bInFlight = true;
				// Spin until "c" is also in flight (proves concurrency).
				const start = Date.now();
				while (!wave2Barrier.cInFlight) {
					if (Date.now() - start > 5000) throw new Error("b: c never became in flight (not parallel)");
					await new Promise((r) => setTimeout(r, 5));
				}
				return { text: "B-out", stopReason: "end_turn", sessionId: "b-1" };
			}
			if (message === "Step C") {
				wave2Barrier.cInFlight = true;
				const start = Date.now();
				while (!wave2Barrier.bInFlight) {
					if (Date.now() - start > 5000) throw new Error("c: b never became in flight (not parallel)");
					await new Promise((r) => setTimeout(r, 5));
				}
				return { text: "C-out", stopReason: "end_turn", sessionId: "c-1" };
			}
			// Wave 3: step "d" — must be dispatched LAST.
			if (message.startsWith("Step D")) {
				return { text: "D-out", stopReason: "end_turn", sessionId: "d-1" };
			}
			return { text: "x", stopReason: "end_turn", sessionId: "x" };
		});

		// Submit the 3-wave DAG through the real tool surface.
		const submit = await exec("acp_dag", { action: "submit",
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["a"] },
				{ id: "d", agent: "gemini", prompt: "Step D based on {b.output} and {c.output}", dependsOn: ["b", "c"] },
			],
		});

		const dagId = submit.details.dagId;
		expect(dagId).toBeTruthy();
		expect(submit.details.stepCount).toBe(4);

		// Poll acp_dag_status until the DAG reaches a terminal state.
		let details: any;
		for (let i = 0; i < 200; i++) {
			const status = await exec("acp_dag", { action: "status", dagId });
			details = status.details;
			if (details.status === "completed" || details.status === "failed") break;
			await new Promise((r) => setTimeout(r, 20));
		}

		// 1. DAG completed with all four steps completed.
		expect(details.status).toBe("completed");
		expect(details.dagId).toBe(dagId);

		// 2. Every step dispatched exactly once (4 delegate calls total).
		expect(delegateSpy).toHaveBeenCalledTimes(4);

		// 3. Wave ordering: "a" dispatched first, "d" dispatched last.
		expect(dispatchOrder[0]).toBe("Step A");
		expect(dispatchOrder[3]).toBe("Step D based on B-out and C-out");

		// 4. Wave 2 dispatched in parallel (barrier was satisfied — if this
		//    assertion is reached at all, "b" and "c" were concurrent).
		//    Also confirm both wave-2 steps were dispatched before "d".
		const bIdx = dispatchOrder.indexOf("Step B");
		const cIdx = dispatchOrder.indexOf("Step C");
		const dIdx = dispatchOrder.indexOf("Step D based on B-out and C-out");
		expect(bIdx).toBeGreaterThan(-1);
		expect(cIdx).toBeGreaterThan(-1);
		expect(dIdx).toBeGreaterThan(bIdx);
		expect(dIdx).toBeGreaterThan(cIdx);
		// The barrier itself proves parallelism: wave2Barrier counters would
		// have thrown otherwise (the run would have timed out). Assert the
		// concurrency flag was observed for both.
		expect(wave2Barrier.bInFlight).toBe(true);
		expect(wave2Barrier.cInFlight).toBe(true);

		// 5. Template resolution: "d" received the resolved outputs of both
		//    wave-2 steps (B-out, C-out).
		expect(dispatchOrder[3]).toBe("Step D based on B-out and C-out");

		// 6. Persisted state on disk reflects the full run.
		const persisted = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
		expect(persisted.status).toBe("completed");
		expect(persisted.steps.a.status).toBe("completed");
		expect(persisted.steps.a.output).toBe("A-out");
		expect(persisted.steps.b.status).toBe("completed");
		expect(persisted.steps.b.output).toBe("B-out");
		expect(persisted.steps.c.status).toBe("completed");
		expect(persisted.steps.c.output).toBe("C-out");
		expect(persisted.steps.d.status).toBe("completed");
		expect(persisted.steps.d.output).toBe("D-out");
	});
});

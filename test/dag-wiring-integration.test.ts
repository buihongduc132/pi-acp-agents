/**
 * RED test for task 7.1 — Wire `DagExecutor` constructor with existing
 * `AgentCoordinator`, `AsyncExecutor`, and `CircuitBreaker` instances
 * from `index.ts`.
 *
 * Behavior under test: when `acp_dag_submit` constructs a `DagExecutor`
 * to drive a DAG, it MUST pass three existing-infrastructure singletons
 * from `index.ts`:
 *   1. an `AgentCoordinator` instance
 *   2. an `AsyncExecutor` instance (the existing background-dispatch executor)
 *   3. the shared `CircuitBreaker` instance (`cb`)
 *
 * Per design.md ("Integration with existing infrastructure") and the
 * DagExecutor docstring, the wave loop is driven directly by the executor
 * (it does not hand dispatch off to AsyncExecutor), but the AsyncExecutor
 * is still retained on the instance as part of the integration wiring.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpSessionHandle } from "../src/config/types.js";

vi.mock("../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
vi.mock("../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: vi.fn(),
}));
vi.mock("../src/management/session-name-store.js", () => ({
	SessionNameStore: vi.fn(),
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
		workersFile: "/mock/runtime/workers.json",
		dagDir: "/mock/runtime/dag",
		dagIndexFile: "/mock/runtime/dag/dag-index.json",
	}),
}));
vi.mock("../src/logger.js", () => ({
	createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", () => ({
	AgentCoordinator: vi.fn(),
}));
vi.mock("../src/core/async-executor.js", () => ({ AsyncExecutor: vi.fn() }));
vi.mock("../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));

vi.mock("../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));

// DagExecutor is spied with a constructor-capture mock so we can assert the
// exact options object passed to it on each tool call. `vi.hoisted` makes
// the reference available to the hoisted `vi.mock` factory.
const { dagExecutorConstructor } = vi.hoisted(() => {
	const dagExecutorConstructor = vi.fn(function (this: any, options: any) {
		Object.assign(this, options);
		this.execute = vi.fn(async () => undefined);
		this.cancel = vi.fn(async () => ({ completed: 0, aborted: 0, cancelled: 0 }));
		this.resumeAll = vi.fn(async () => []);
	});
	return { dagExecutorConstructor };
});
vi.mock("../src/dag/dag-executor.js", () => ({ DagExecutor: dagExecutorConstructor }));

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
import { AsyncExecutor } from "../src/core/async-executor.js";
import { DagStore } from "../src/dag/dag-store.js";
import { DagValidator } from "../src/dag/dag-validator.js";
import { TemplateResolver } from "../src/dag/template-resolver.js";

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

describe("DAG wiring — task 7.1 (existing infra singletons into DagExecutor)", () => {
	let tools: Map<string, any>;
	let m: any;

	beforeEach(() => {
		tools = new Map();
		m = {
			sm: { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0 },
			ts: { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) },
			gs: { getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(), getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) },
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed", isHealthy: vi.fn(() => true), recordSuccess: vi.fn(), recordFailure: vi.fn() },
			hm: { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() },
			ad: { spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "ses-1"), loadSession: vi.fn(), prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "ses-1" })), setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn() },
			co: { delegate: vi.fn(async () => ({ text: "delegated", stopReason: "end_turn", sessionId: "d1" })), broadcast: vi.fn(async () => []), compare: vi.fn(async () => ({ responses: [], timestamp: new Date().toISOString() })), dispose: vi.fn() },
			asyncExec: { start: vi.fn(() => "run-1"), cancel: vi.fn(), list: vi.fn(() => []) },
			dagStore: {
				create: vi.fn((definition: any) => ({
					dagId: "dag-uuid-1234",
					tasks: definition.tasks,
					args: definition.args,
					options: definition.options,
					status: "pending",
					steps: {},
					currentWave: 0,
					totalWaves: 0,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})),
				get: vi.fn(),
				updateStep: vi.fn(),
				updateDagStatus: vi.fn(),
				listAll: vi.fn(() => []),
				findRunning: vi.fn(() => []),
			},
			dagValidator: { validate: vi.fn(() => ({ valid: true, errors: [] })) },
			templateResolver: { resolve: vi.fn((p: string) => p) },
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
		(AsyncExecutor as any).mockImplementation(function () { return m.asyncExec; });
		(DagStore as any).mockImplementation(function () { return m.dagStore; });
		(DagValidator as any).mockImplementation(function () { return m.dagValidator; });
		(TemplateResolver as any).mockImplementation(function () { return m.templateResolver; });

		main({
			registerTool: vi.fn((t: any) => tools.set(t.name, t)),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);

		// Clear after load so the task 7.3 resume-on-startup DagExecutor
		// construction does not count toward per-tool-call assertions.
		dagExecutorConstructor.mockClear();
	});

	const exec = (name: string, params: any) =>
		tools.get(name)!.execute("t", params, undefined, undefined, ctx);

	it("acp_dag_submit wires DagExecutor with coordinator, asyncExecutor, and circuitBreaker", async () => {
		await exec("acp_dag_submit", {
			tasks: [{ id: "a", agent: "gemini", prompt: "Research X" }],
		});

		expect(dagExecutorConstructor).toHaveBeenCalledTimes(1);
		const options = dagExecutorConstructor.mock.calls[0][0];

		// AgentCoordinator instance wired.
		expect(options.coordinator).toBe(m.co);
		// Shared CircuitBreaker instance wired.
		expect(options.circuitBreaker).toBe(m.cb);
		// AsyncExecutor instance wired (the missing piece for task 7.1).
		expect(options.asyncExecutor).toBe(m.asyncExec);
	});

	it("acp_dag_cancel wires DagExecutor with coordinator, asyncExecutor, and circuitBreaker", async () => {
		await exec("acp_dag_cancel", { dagId: "dag-1" });

		expect(dagExecutorConstructor).toHaveBeenCalledTimes(1);
		const options = dagExecutorConstructor.mock.calls[0][0];

		expect(options.coordinator).toBe(m.co);
		expect(options.circuitBreaker).toBe(m.cb);
		expect(options.asyncExecutor).toBe(m.asyncExec);
	});
});

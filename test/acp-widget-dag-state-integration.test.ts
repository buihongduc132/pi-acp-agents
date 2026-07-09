/**
 * Task 4.8 — Integration test: submit a DAG via a real `DagStore.create()`,
 * call the real `getWidgetState()` closure (captured via createAcpWidget's
 * getState argument), and assert `state.dags` is populated with correct
 * counts (mapping DagIndexEntry → AcpWidgetDag).
 *
 * Unlike `acp-widget-dags-wiring.test.ts` (task 3.2), which feeds
 * `listAll()` mock data directly, this test uses a REAL `DagStore` backed by
 * a tmp dir — exercising the full on-disk create → listAll → widget-mapping
 * pipeline. The only mock is the surrounding `index.ts` infra
 * (SessionManager, WorkerStore, etc.) that is irrelevant to the DAG path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", () => ({
	GovernanceStore: vi.fn(),
}));
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
vi.mock("../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));
vi.mock("../src/dag/dag-executor.js", () => ({
	DagExecutor: vi.fn(function (this: any, options: any) {
		Object.assign(this, options);
		this.execute = vi.fn(async () => undefined);
		this.cancel = vi.fn(async () => ({ completed: 0, aborted: 0, cancelled: 0 }));
		this.resumeAll = vi.fn(async () => []);
		this.markStale = vi.fn();
	}),
}));

// Capture the getState function passed to the panel deps adapter so the test can
// invoke it directly and inspect the produced AcpWidgetState.dags.
const { capturedGetState } = vi.hoisted(() => ({
	capturedGetState: { current: null as null | (() => any) },
}));
vi.mock("../src/acp-widget.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/acp-widget.js")>();
	return {
		...actual,
		createAcpWidget: (opts: any) => {
			capturedGetState.current = opts.getState;
			return () => ({ render: vi.fn() });
		},
	};
});
vi.mock("../src/tui/panel-deps.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/tui/panel-deps.js")>();
	return {
		...actual,
		buildAcpPanelDepsReadOnly: (sources: any) => {
			if (sources?.getState) capturedGetState.current = sources.getState;
			return actual.buildAcpPanelDepsReadOnly(sources);
		},
	};
});

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
	agent_servers: { gemini: { command: "gemini", args: ["--acp"] } },
	defaultAgent: "gemini",
	staleTimeoutMs: 3_600_000,
	circuitBreakerMaxFailures: 3,
	circuitBreakerResetMs: 60_000,
	stallTimeoutMs: 300_000,
	modelPolicy: {},
	dagStaleTimeoutMs: 3_600_000,
	dagOutputTruncateChars: 8000,
};

describe("Integration: getWidgetState().dags populated from dagStore.create() (task 4.8)", () => {
	let tmpDir: string;
	let dagStoreInstance: InstanceType<typeof DagStore>;
	let RealDagStore: typeof DagStore;

	beforeEach(async () => {
		// Import the real DagStore class (the module is mocked so index.ts
		// receives our instance instead of constructing its own).
		const actual = await vi.importActual<typeof import("../src/dag/dag-store.js")>("../src/dag/dag-store.js");
		RealDagStore = actual.DagStore;

		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-widget-int-"));
		const dagDir = join(tmpDir, "dag");
		const dagIndexFile = join(dagDir, "dag-index.json");
		dagStoreInstance = new RealDagStore({ dagDir, dagIndexFile });

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () {
			return { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0 };
		});
		(AcpTaskStore as any).mockImplementation(function () {
			return { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })), updateWhere: vi.fn(() => []) };
		});
		(MailboxManager as any).mockImplementation(function () {
			return { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0), listAll: vi.fn(() => []) };
		});
		(GovernanceStore as any).mockImplementation(function () {
			return { getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(), getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) };
		});
		(AcpEventLog as any).mockImplementation(function () {
			return { append: vi.fn() };
		});
		(AcpCircuitBreaker as any).mockImplementation(function () {
			return { execute: vi.fn(async (fn: () => any) => fn()), state: "closed", isHealthy: vi.fn(() => true), recordSuccess: vi.fn(), recordFailure: vi.fn() };
		});
		(HealthMonitor as any).mockImplementation(function () {
			return { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() };
		});
		(createAdapter as any).mockImplementation(function () {
			return { spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(), loadSession: vi.fn(), prompt: vi.fn(), setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
		});
		(AgentCoordinator as any).mockImplementation(function () {
			return { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn() };
		});
		(AsyncExecutor as any).mockImplementation(function () {
			return { start: vi.fn(), cancel: vi.fn(), list: vi.fn(() => []) };
		});
		(DagStore as any).mockImplementation(function () {
			return dagStoreInstance;
		});
		(DagValidator as any).mockImplementation(function () {
			return { validate: vi.fn(() => ({ valid: true, errors: [] })) };
		});
		(TemplateResolver as any).mockImplementation(function () {
			return { resolve: vi.fn((p: string) => p) };
		});

		capturedGetState.current = null;

		main({
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("submits a DAG via dagStore.create(), reads getWidgetState(), and asserts state.dags counts after transition to running", () => {
		// 1. Submit a 3-step DAG via the real DagStore.
		const record = dagStoreInstance.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "step a" },
				{ id: "b", agent: "gemini", prompt: "step b", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "step c", dependsOn: ["b"] },
			],
		});

		// 2. Simulate the executor: transition the DAG to running, then mark
		//    step a completed and step b failed (updateStep reconciles the
		//    index counters; updateDagStatus reflects the DAG status).
		dagStoreInstance.updateDagStatus(record.dagId, "running");
		dagStoreInstance.updateStep(record.dagId, "a", (s) => ({
			...s,
			status: "completed",
			output: "done",
			completedAt: new Date().toISOString(),
		}));
		dagStoreInstance.updateStep(record.dagId, "b", (s) => ({
			...s,
			status: "failed",
			error: "boom",
			completedAt: new Date().toISOString(),
		}));

		// 3. Call the real getWidgetState() closure.
		expect(capturedGetState.current).not.toBeNull();
		const state = capturedGetState.current!();

		// 4. Assert state.dags is populated with correct counts (field-name
		//    remapping: totalSteps→total, completedSteps→completed,
		//    failedSteps→failed).
		expect(state.dags).toBeDefined();
		expect(state.dags).toHaveLength(1);
		const dag = state.dags[0];
		expect(dag.dagId).toBe(record.dagId);
		expect(dag.status).toBe("running");
		expect(dag.total).toBe(3);
		expect(dag.completed).toBe(1);
		expect(dag.failed).toBe(1);
		expect(dag.cancelled).toBe(0);
		expect(dag.createdAt).toBeInstanceOf(Date);
		expect(dag.updatedAt).toBeInstanceOf(Date);
	});

	it("does not surface a freshly created (pending) DAG — pending is filtered", () => {
		dagStoreInstance.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "x" }],
		});

		const state = capturedGetState.current!();
		expect(state.dags).toEqual([]);
	});

	it("round-trips multiple submitted DAGs through getWidgetState()", () => {
		const r1 = dagStoreInstance.create({
			tasks: [{ id: "a", agent: "gemini", prompt: "x" }],
		});
		const r2 = dagStoreInstance.create({
			tasks: [
				{ id: "a", agent: "gemini", prompt: "x" },
				{ id: "b", agent: "gemini", prompt: "y" },
			],
		});
		dagStoreInstance.updateDagStatus(r1.dagId, "completed");
		dagStoreInstance.updateDagStatus(r2.dagId, "running");
		dagStoreInstance.updateStep(r2.dagId, "a", (s) => ({
			...s,
			status: "completed",
			output: "done",
			completedAt: new Date().toISOString(),
		}));

		const state = capturedGetState.current!();
		expect(state.dags).toHaveLength(2);
		// Newest first (updatedAt desc).
		const ids = state.dags.map((d: any) => d.dagId);
		expect(ids).toContain(r1.dagId);
		expect(ids).toContain(r2.dagId);
		const running = state.dags.find((d: any) => d.dagId === r2.dagId);
		expect(running.status).toBe("running");
		expect(running.total).toBe(2);
		expect(running.completed).toBe(1);
	});
});

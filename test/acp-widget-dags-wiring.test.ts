/**
 * RED test for task 3.2 — In `index.ts`'s `getWidgetState()` builder, after
 * the existing `workers` population, add `dags: dagStore.listAll()` mapped to
 * `AcpWidgetDag[]` (filter out `pending`; cap 5 by `updatedAt` desc).
 *
 * Behavior under test: `getWidgetState()` MUST read `dagStore.listAll()`,
 * map each `DagIndexEntry` to an `AcpWidgetDag`, drop entries whose status is
 * `pending`, sort by `updatedAt` descending, and cap the result at 5 entries.
 *
 * Field mapping (per design.md D1 + task 3.4):
 *   status          → status
 *   totalSteps      → total
 *   completedSteps  → completed
 *   failedSteps     → failed
 *   createdAt        → createdAt (Date)
 *   updatedAt        → updatedAt (Date)
 *   cancelled is not carried by DagIndexEntry → defaults to 0
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

vi.mock("../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));

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
import type { DagIndexEntry } from "../src/config/types.js";

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

function entry(overrides: Partial<DagIndexEntry>): DagIndexEntry {
	return {
		dagId: "dag",
		status: "running",
		totalSteps: 5,
		completedSteps: 2,
		failedSteps: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("getWidgetState() dags wiring — task 3.2", () => {
	let dagStoreInstance: any;

	beforeEach(() => {
		dagStoreInstance = { listAll: vi.fn(() => []), create: vi.fn(), get: vi.fn(), updateStep: vi.fn(), updateDagStatus: vi.fn(), findRunning: vi.fn(() => []) };
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

	it("populates state.dags from dagStore.listAll() with mapped fields", () => {
		dagStoreInstance.listAll.mockReturnValue([
			entry({ dagId: "d1", status: "running", totalSteps: 7, completedSteps: 4, failedSteps: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:05:00.000Z" }),
		]);

		const state = capturedGetState.current!();
		expect(state.dags).toBeDefined();
		expect(state.dags).toHaveLength(1);
		const dag = state.dags![0];
		expect(dag.dagId).toBe("d1");
		expect(dag.status).toBe("running");
		expect(dag.total).toBe(7);
		expect(dag.completed).toBe(4);
		expect(dag.failed).toBe(2);
		expect(dag.cancelled).toBe(0);
		expect(dag.createdAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
		expect(dag.updatedAt).toEqual(new Date("2026-01-01T00:05:00.000Z"));
	});

	it("filters out pending DAGs", () => {
		dagStoreInstance.listAll.mockReturnValue([
			entry({ dagId: "pending-1", status: "pending" }),
			entry({ dagId: "running-1", status: "running" }),
			entry({ dagId: "pending-2", status: "pending" }),
			entry({ dagId: "completed-1", status: "completed" }),
		]);

		const state = capturedGetState.current!();
		expect(state.dags!.map((d: any) => d.dagId).sort()).toEqual(["completed-1", "running-1"]);
	});

	it("sorts by updatedAt descending and caps at 5 entries", () => {
		const entries: DagIndexEntry[] = [];
		for (let i = 0; i < 7; i++) {
			entries.push(entry({
				dagId: `d${i}`,
				status: "running",
				// d0 oldest ... d6 newest
				updatedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
			}));
		}
		dagStoreInstance.listAll.mockReturnValue(entries);

		const state = capturedGetState.current!();
		expect(state.dags).toHaveLength(5);
		// Newest first → d6, d5, d4, d3, d2
		expect(state.dags!.map((d: any) => d.dagId)).toEqual(["d6", "d5", "d4", "d3", "d2"]);
	});

	it("returns empty dags array when store has no DAGs", () => {
		dagStoreInstance.listAll.mockReturnValue([]);
		const state = capturedGetState.current!();
		expect(state.dags).toEqual([]);
	});
});

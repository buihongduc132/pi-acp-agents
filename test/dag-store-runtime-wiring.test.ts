/**
 * RED test for task 7.2 — Initialize `DagStore` with runtime directory path
 * from `runtime-paths.ts`.
 *
 * Behavior under test: when the extension's `main()` factory runs, it MUST
 * construct exactly one `DagStore` instance and pass it the `dagDir` and
 * `dagIndexFile` values sourced from `runtime-paths.ts` (i.e. the values
 * returned by `ensureRuntimeDir(...)`). The store MUST NOT receive a
 * hard-coded path or a path derived from any source other than the runtime
 * paths object.
 *
 * Per design.md D7: DAG state files live under
 * `~/.pi/acp-agents/dag/<dagId>.json` plus `dag-index.json`, and the path is
 * surfaced via `AcpRuntimePaths.dagDir` / `dagIndexFile`.
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

// The runtime-paths mock returns DISTINCT, recognizable path values so the
// test can assert DagStore received EXACTLY these (and not a hard-coded
// fallback). This is the crux of task 7.2.
const EXPECTED_DAG_DIR = "/mock/runtime/dag";
const EXPECTED_DAG_INDEX = "/mock/runtime/dag/dag-index.json";
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
		dagDir: EXPECTED_DAG_DIR,
		dagIndexFile: EXPECTED_DAG_INDEX,
	}),
}));
vi.mock("../src/logger.js", () => ({
	createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

vi.mock("../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));
vi.mock("../src/dag/dag-executor.js", () => ({
	DagExecutor: vi.fn(function (this: any, options: any) {
		Object.assign(this, options);
	}),
}));

// Constructor-capture mock for DagStore — records the exact options object
// passed to `new DagStore(...)` in index.ts.
const { dagStoreConstructor } = vi.hoisted(() => {
	const dagStoreConstructor = vi.fn(function (this: any, options: any) {
		Object.assign(this, options);
	});
	return { dagStoreConstructor };
});
vi.mock("../src/dag/dag-store.js", () => ({ DagStore: dagStoreConstructor }));

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

describe("DAG wiring — task 7.2 (DagStore initialized from runtime-paths.ts)", () => {
	beforeEach(() => {
		dagStoreConstructor.mockClear();

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () {
			return {
				add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []),
				remove: vi.fn(), disposeAll: vi.fn(),
				pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0,
				getSessionId: vi.fn(() => "ses-default"),
			};
		});
		(AcpTaskStore as any).mockImplementation(function () {
			return { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) };
		});
		(MailboxManager as any).mockImplementation(function () {
			return { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) };
		});
		(GovernanceStore as any).mockImplementation(function () {
			return {
				getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: vi.fn(),
				checkModel: vi.fn(() => ({ ok: true, reason: "" })),
			};
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
			return {
				spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "ses-1"),
				loadSession: vi.fn(), prompt: vi.fn(async () => ({ text: "r", stopReason: "end_turn", sessionId: "ses-1" })),
				setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
			};
		});
		(AgentCoordinator as any).mockImplementation(function () {
			return { delegate: vi.fn(async () => ({ text: "d", stopReason: "end_turn", sessionId: "d1" })), broadcast: vi.fn(async () => []), compare: vi.fn(async () => ({ responses: [], timestamp: new Date().toISOString() })) };
		});
		(AsyncExecutor as any).mockImplementation(function () {
			return { start: vi.fn(() => "run-1"), cancel: vi.fn(), list: vi.fn(() => []) };
		});
		(DagValidator as any).mockImplementation(function () {
			return { validate: vi.fn(() => ({ valid: true, errors: [] })) };
		});
		(TemplateResolver as any).mockImplementation(function () {
			return { resolve: vi.fn((p: string) => p) };
		});

		main({
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
	});

	it("constructs exactly one DagStore at extension load", () => {
		expect(dagStoreConstructor).toHaveBeenCalledTimes(1);
	});

	it("passes dagDir from runtime-paths.ts to DagStore", () => {
		const options = dagStoreConstructor.mock.calls[0][0];
		expect(options.dagDir).toBe(EXPECTED_DAG_DIR);
	});

	it("passes dagIndexFile from runtime-paths.ts to DagStore", () => {
		const options = dagStoreConstructor.mock.calls[0][0];
		expect(options.dagIndexFile).toBe(EXPECTED_DAG_INDEX);
	});

	it("does not pass a hard-coded dagDir fallback", () => {
		const options = dagStoreConstructor.mock.calls[0][0];
		// Must be the runtime-paths value, not a hard-coded ~/.pi/acp-agents/dag
		expect(options.dagDir).not.toContain(homedirSafe());
		expect(options.dagDir).toBe(EXPECTED_DAG_DIR);
	});
});

function homedirSafe(): string {
	try {
		// Avoid importing node:os at top-level so the failure message stays clean.
		return require("node:os").homedir();
	} catch {
		return "";
	}
}

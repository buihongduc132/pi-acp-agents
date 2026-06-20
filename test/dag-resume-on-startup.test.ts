/**
 * RED test for task 7.3 — Add resume-on-startup hook in extension `index.ts`:
 * call `DagExecutor.resumeAll()` on extension load.
 *
 * Behavior under test: when the extension's default export (`main`) is
 * invoked (i.e. pi loads the extension at startup), the extension MUST
 * construct a `DagExecutor` and invoke its `resumeAll()` method so that
 * DAGs persisted in `running` state are resumed from their last checkpoint
 * (specs/dag-resume "Resume from last checkpoint after pi restart").
 *
 * The resume call MUST be fire-and-forget tolerant — it MUST NOT throw
 * synchronously into the extension load path (errors are caught and logged).
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
vi.mock("../src/management/worker-store.js", () => ({ WorkerStore: vi.fn() }));
vi.mock("../src/management/session-store-factory.js", () => ({
	SessionStoreFactory: vi.fn(function () {
		return {
			get: () => ({
				taskStore: {},
				workerStore: {},
				mailboxManager: {},
				governanceStore: { setModelPolicy: vi.fn() },
			}),
		};
	}),
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
	createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", () => ({
	AgentCoordinator: vi.fn(),
}));
vi.mock("../src/coordination/worker-dispatcher.js", () => ({
	WorkerDispatcher: vi.fn(function () {
		return { start: vi.fn(), stop: vi.fn() };
	}),
}));
vi.mock("../src/core/async-executor.js", () => ({ AsyncExecutor: vi.fn() }));
vi.mock("../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));
vi.mock("../src/settings/config.js", () => ({
	loadSettings: () => ({}),
	isToolEnabled: () => false,
}));
vi.mock("../src/settings/configure-tui.js", () => ({
	configureToolSettings: vi.fn(),
}));

vi.mock("../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));

// Capture every DagExecutor instance created so we can assert that one of
// them had `resumeAll()` invoked during extension load. `resumeAllImpl` is
// mutable so individual tests can force rejection.
const { dagExecutorInstances, DagExecutorMock } = vi.hoisted(() => {
	const dagExecutorInstances: any[] = [];
	// Module-level flag — setupMocks sets this before main() constructs instances.
	let resumeAllShouldReject = false;

	class DagExecutorMock {
		execute!: ReturnType<typeof vi.fn>;
		cancel!: ReturnType<typeof vi.fn>;
		markStale: ReturnType<typeof vi.fn>;
		resumeAll: ReturnType<typeof vi.fn>;
		constructor(options: any) {
			Object.assign(this, options);
			this.execute = vi.fn(async () => undefined);
			this.cancel = vi.fn(async () => ({ completed: 0, aborted: 0, cancelled: 0 }));
			this.markStale = vi.fn();
			// Each instance gets its own resumeAll mock, respecting the
			// rejection flag set by setupMocks({ resumeAllRejects: true }).
			this.resumeAll = resumeAllShouldReject
				? vi.fn(async () => { throw new Error("disk corruption"); })
				: vi.fn(async () => []);
			dagExecutorInstances.push(this);
		}
	}
	// Expose flag setter for setupMocks
	(DagExecutorMock as any)._setResumeAllRejects = (v: boolean) => { resumeAllShouldReject = v; };
	return { dagExecutorInstances, DagExecutorMock };
});
vi.mock("../src/dag/dag-executor.js", () => ({ DagExecutor: DagExecutorMock }));

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

function setupMocks(overrides: { resumeAllRejects?: boolean } = {}) {
	(loadConfig as any).mockReturnValue(CFG);
	(SessionManager as any).mockImplementation(function () {
		return { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), size: 0 };
	});
	(AcpTaskStore as any).mockImplementation(function () { return {}; });
	(MailboxManager as any).mockImplementation(function () { return {}; });
	(GovernanceStore as any).mockImplementation(function () { return { setModelPolicy: vi.fn() }; });
	(AcpEventLog as any).mockImplementation(function () { return { append: vi.fn() }; });
	(AcpCircuitBreaker as any).mockImplementation(function () {
		return { execute: vi.fn(async (fn: () => any) => fn()), state: "closed", isHealthy: vi.fn(() => true), recordSuccess: vi.fn(), recordFailure: vi.fn() };
	});
	(HealthMonitor as any).mockImplementation(function () {
		return { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() };
	});
	(createAdapter as any).mockImplementation(function () { return {}; });
	(AgentCoordinator as any).mockImplementation(function () { return {}; });
	(AsyncExecutor as any).mockImplementation(function () { return {}; });
	(DagStore as any).mockImplementation(function () {
		return { create: vi.fn(), get: vi.fn(), updateStep: vi.fn(), updateDagStatus: vi.fn(), listAll: vi.fn(() => []), findRunning: vi.fn(() => []) };
	});
	(DagValidator as any).mockImplementation(function () { return { validate: vi.fn(() => ({ valid: true, errors: [] })) }; });
	(TemplateResolver as any).mockImplementation(function () { return { resolve: vi.fn((p: string) => p) }; });

	// Force any subsequently constructed DagExecutor's resumeAll to reject.
	if (overrides.resumeAllRejects) {
		(DagExecutorMock as any)._setResumeAllRejects(true);
	} else {
		(DagExecutorMock as any)._setResumeAllRejects(false);
	}
}

describe("DAG resume-on-startup — task 7.3 (DagExecutor.resumeAll() on load)", () => {
	beforeEach(() => {
		dagExecutorInstances.length = 0;
	});

	it("invokes DagExecutor.resumeAll() when the extension loads", () => {
		setupMocks();

		main({
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);

		// At least one DagExecutor must have been constructed during load…
		expect(dagExecutorInstances.length).toBeGreaterThanOrEqual(1);

		// …and exactly one of them must have had resumeAll() called.
		const resumed = dagExecutorInstances.filter((i) => i.resumeAll.mock.calls.length > 0);
		expect(resumed.length).toBe(1);
		expect(resumed[0].resumeAll).toHaveBeenCalledTimes(1);
	});

	it("does not throw into the extension load path if resumeAll rejects", () => {
		setupMocks({ resumeAllRejects: true });

		expect(() => {
			main({
				registerTool: vi.fn(),
				registerCommand: vi.fn(),
				on: vi.fn(),
			} as any);
		}).not.toThrow();
	});
});

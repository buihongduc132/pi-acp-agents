/**
 * Tests for the `acp_dag_status` tool registered in index.ts (task 6.2).
 *
 * The tool accepts an optional `{ dagId }`:
 *  - dagId provided    → returns the full DAG state (DagRecord)
 *  - dagId omitted      → returns a listing of all DAGs (DagIndexEntry[])
 *  - dagId not found    → returns an error: DAG "<dagId>" not found
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpSessionHandle } from "../src/config/types.js";
import type { DagRecord, DagIndexEntry } from "../src/config/types.js";

vi.mock("../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
vi.mock("../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class {
		get = vi.fn();
		upsert = vi.fn((s: AcpSessionHandle) => s);
	},
}));
vi.mock("../src/management/session-name-store.js", () => ({
	SessionNameStore: class {
		getSessionId = vi.fn();
		getName = vi.fn();
		register = vi.fn();
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
import { DagStore } from "../src/dag/dag-store.js";

const CFG = {
	agent_servers: { gemini: { command: "gemini", args: ["--acp"] } },
	defaultAgent: "gemini", staleTimeoutMs: 3_600_000, circuitBreakerMaxFailures: 3,
	circuitBreakerResetMs: 60_000, stallTimeoutMs: 300_000, modelPolicy: {},
};

describe("acp_dag_status tool", () => {
	let tools: Map<string, any>;
	let dagStoreMock: { get: ReturnType<typeof vi.fn>; listAll: ReturnType<typeof vi.fn> };
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	beforeEach(() => {
		tools = new Map();
		dagStoreMock = {
			get: vi.fn(),
			listAll: vi.fn(),
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () {
			return { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), size: 0 };
		});
		(AcpTaskStore as any).mockImplementation(function () { return {}; });
		(MailboxManager as any).mockImplementation(function () { return {}; });
		(GovernanceStore as any).mockImplementation(function () { return { setModelPolicy: vi.fn() }; });
		(AcpEventLog as any).mockImplementation(function () { return { append: vi.fn() }; });
		(AcpCircuitBreaker as any).mockImplementation(function () {
			return { execute: vi.fn(async (fn: () => any) => fn()), state: "closed", isHealthy: vi.fn(() => true) };
		});
		(HealthMonitor as any).mockImplementation(function () {
			return { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() };
		});
		(createAdapter as any).mockImplementation(function () {
			return { spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(), prompt: vi.fn(), dispose: vi.fn() };
		});
		(AgentCoordinator as any).mockImplementation(function () { return {}; });
		(DagStore as any).mockImplementation(function () { return dagStoreMock; });

		main({
			registerTool: vi.fn((t: any) => tools.set(t.name, t)),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
	});

	const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);

	it("registers the acp_dag_status tool", () => {
		expect(tools.has("acp_dag_status")).toBe(true);
		const params = (tools.get("acp_dag_status").parameters as any).properties;
		expect(params).toHaveProperty("dagId");
	});

	it("returns the full DAG state when dagId is provided", async () => {
		const record: DagRecord = {
			dagId: "dag-1",
			tasks: [{ id: "a", agent: "gemini", prompt: "do" }],
			args: undefined,
			options: { failFast: true, maxRetries: 0 },
			status: "running",
			steps: {
				a: { id: "a", agent: "gemini", prompt: "do", dependsOn: [], gate: "needs", status: "completed", output: "result", retryCount: 0 },
			},
			currentWave: 1,
			totalWaves: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:01.000Z",
		};
		dagStoreMock.get.mockReturnValue(record);

		const r = await exec("acp_dag_status", { dagId: "dag-1" });

		expect(dagStoreMock.get).toHaveBeenCalledWith("dag-1");
		const payload = JSON.parse(r.content[0].text);
		expect(payload.dagId).toBe("dag-1");
		expect(payload.status).toBe("running");
		expect(payload.steps.a.status).toBe("completed");
		expect(payload.steps.a.output).toBe("result");
	});

	it("returns a listing of all DAGs when dagId is omitted", async () => {
		const entries: DagIndexEntry[] = [
			{ dagId: "dag-1", status: "running", totalSteps: 2, completedSteps: 1, failedSteps: 0, createdAt: "t1", updatedAt: "t2" },
			{ dagId: "dag-2", status: "completed", totalSteps: 3, completedSteps: 3, failedSteps: 0, createdAt: "t3", updatedAt: "t4", completedAt: "t5" },
		];
		dagStoreMock.listAll.mockReturnValue(entries);

		const r = await exec("acp_dag_status", {});

		expect(dagStoreMock.listAll).toHaveBeenCalled();
		const payload = JSON.parse(r.content[0].text);
		expect(payload.dags).toHaveLength(2);
		expect(payload.dags[0].dagId).toBe("dag-1");
		expect(payload.dags[1].status).toBe("completed");
	});

	it("returns an empty list when no DAGs exist", async () => {
		dagStoreMock.listAll.mockReturnValue([]);

		const r = await exec("acp_dag_status", {});

		const payload = JSON.parse(r.content[0].text);
		expect(payload.dags).toEqual([]);
	});

	it("returns a not-found error when dagId does not exist", async () => {
		dagStoreMock.get.mockReturnValue(null);

		const r = await exec("acp_dag_status", { dagId: "missing" });

		expect(r.content[0].text).toContain('DAG "missing" not found');
	});
});

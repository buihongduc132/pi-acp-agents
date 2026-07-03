/**
 * RED test for task 6.3 — Register `acp_dag_cancel` tool in index.ts.
 *
 * Behavior under test: the tool must
 *  1. be registered with name `acp_dag_cancel`
 *  2. accept a required `{ dagId }` parameter (Type.String)
 *  3. call `DagExecutor.cancel(dagId)` and return the summary
 *     `{ completed, aborted, cancelled }`
 *  4. surface executor errors (e.g. already completed / not found) as
 *     content text without throwing
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
	createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", () => ({
	AgentCoordinator: vi.fn(),
}));
vi.mock("../src/core/async-executor.js", () => ({
	AsyncExecutor: vi.fn(),
}));
vi.mock("../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));

vi.mock("../src/dag/dag-store.js", () => ({
	DagStore: vi.fn(),
}));
vi.mock("../src/dag/dag-validator.js", () => ({
	DagValidator: vi.fn(),
}));
vi.mock("../src/dag/dag-executor.js", () => ({
	DagExecutor: vi.fn(),
}));
vi.mock("../src/dag/template-resolver.js", () => ({
	TemplateResolver: vi.fn(),
}));

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
import { DagValidator } from "../src/dag/dag-validator.js";
import { DagExecutor } from "../src/dag/dag-executor.js";
import { TemplateResolver } from "../src/dag/template-resolver.js";

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
	dagStaleTimeoutMs: 3_600_000,
	dagOutputTruncateChars: 8000,
};

function mkSession(id: string, agent = "gemini"): AcpSessionHandle {
	return {
		sessionId: id,
		agentName: agent,
		cwd: "/tmp",
		createdAt: new Date(),
		lastActivityAt: new Date(),
		lastResponseAt: undefined,
		completedAt: undefined,
		accumulatedText: "",
		disposed: false,
		busy: false,
		autoClosed: false,
		closeReason: undefined,
		planStatus: "none",
		dispose: vi.fn(),
	} as unknown as AcpSessionHandle;
}

describe("acp_dag_cancel tool (task 6.3)", () => {
	let tools: Map<string, any>;
	let m: any;
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	beforeEach(() => {
		tools = new Map();
		m = {
			sm: {
				add: vi.fn(),
				get: vi.fn(),
				list: vi.fn(() => []),
				listByAgent: vi.fn(() => []),
				remove: vi.fn(),
				disposeAll: vi.fn(),
				pruneStale: vi.fn(async () => ({ removedSessionIds: [] })),
				size: 0,
			},
			ts: {
				create: vi.fn(),
				get: vi.fn(),
				update: vi.fn(),
				list: vi.fn(() => []),
				clear: vi.fn(() => ({ removed: 0, remaining: 0 })),
			},
			mb: {
				send: vi.fn(),
				listFor: vi.fn(() => []),
				clearFor: vi.fn(() => 0),
			},
			gs: {
				getPlan: vi.fn(),
				requestPlan: vi.fn(),
				resolvePlan: vi.fn(),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })),
				setModelPolicy: vi.fn(),
				checkModel: vi.fn(() => ({ ok: true, reason: "" })),
			},
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" },
			hm: {
				start: vi.fn(),
				stop: vi.fn(),
				register: vi.fn(),
				touch: vi.fn(),
				markPromptStart: vi.fn(),
				markPromptEnd: vi.fn(),
			},
			ad: {
				spawn: vi.fn(),
				initialize: vi.fn(),
				newSession: vi.fn(async () => "ses-1"),
				loadSession: vi.fn(),
				prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "ses-1" })),
				setModel: vi.fn(),
				setMode: vi.fn(),
				cancel: vi.fn(),
				dispose: vi.fn(),
			},
			co: {
				delegate: vi.fn(async () => ({ text: "delegated", stopReason: "end_turn", sessionId: "d1" })),
				broadcast: vi.fn(async () => []),
				compare: vi.fn(async () => ({ responses: [], timestamp: new Date().toISOString() })),
			},
			dagStore: {
				create: vi.fn(),
				get: vi.fn(),
				updateStep: vi.fn(),
				updateDagStatus: vi.fn(),
				listAll: vi.fn(() => []),
				findRunning: vi.fn(() => []),
			},
			dagValidator: {
				validate: vi.fn(() => ({ valid: true, errors: [] })),
			},
			dagExecutor: {
				execute: vi.fn(async () => undefined),
				cancel: vi.fn(async () => ({ completed: 0, aborted: 0, cancelled: 0 })),
				resumeAll: vi.fn(async () => []),
			},
			templateResolver: { resolve: vi.fn((p: string) => p) },
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () {
			return m.sm;
		});
		(AcpTaskStore as any).mockImplementation(function () {
			return m.ts;
		});
		(MailboxManager as any).mockImplementation(function () {
			return m.mb;
		});
		(GovernanceStore as any).mockImplementation(function () {
			return m.gs;
		});
		(AcpEventLog as any).mockImplementation(function () {
			return m.el;
		});
		(AcpCircuitBreaker as any).mockImplementation(function () {
			return m.cb;
		});
		(HealthMonitor as any).mockImplementation(function () {
			return m.hm;
		});
		(createAdapter as any).mockImplementation(function () {
			return m.ad;
		});
		(AgentCoordinator as any).mockImplementation(function () {
			return m.co;
		});
		(DagStore as any).mockImplementation(function () {
			return m.dagStore;
		});
		(DagValidator as any).mockImplementation(function () {
			return m.dagValidator;
		});
		(DagExecutor as any).mockImplementation(function () {
			return m.dagExecutor;
		});
		(TemplateResolver as any).mockImplementation(function () {
			return m.templateResolver;
		});

		main({
			registerTool: vi.fn((t: any) => tools.set(t.name, t)),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
	});

	const exec = (name: string, params: any) =>
		tools.get(name)!.execute("t", params, undefined, undefined, ctx);

	it("registers the acp_dag_cancel tool", () => {
		expect(tools.has("acp_dag_cancel")).toBe(true);
	});

	it("exposes a required dagId parameter (Type.String)", () => {
		const params = (tools.get("acp_dag_cancel")?.parameters as any)?.properties ?? {};
		expect(params).toHaveProperty("dagId");
	});

	it("calls DagExecutor.cancel(dagId) and returns the cancellation summary", async () => {
		m.dagExecutor.cancel.mockResolvedValueOnce({ completed: 2, aborted: 1, cancelled: 2 });
		const r = await exec("acp_dag_cancel", { dagId: "dag-1" });

		expect(m.dagExecutor.cancel).toHaveBeenCalledTimes(1);
		expect(m.dagExecutor.cancel).toHaveBeenCalledWith("dag-1");
		expect(r.details).toMatchObject({ completed: 2, aborted: 1, cancelled: 2 });
		expect(r.content[0].text).toContain("dag-1");
	});

	it("surfaces executor errors as content text without throwing", async () => {
		m.dagExecutor.cancel.mockRejectedValueOnce(
			new Error('DAG "dag-1" is already completed and cannot be cancelled'),
		);
		const r = await exec("acp_dag_cancel", { dagId: "dag-1" });

		expect(r.content[0].text).toContain("already completed");
		expect(r.details).toMatchObject({ error: "cancel_failed" });
	});
});

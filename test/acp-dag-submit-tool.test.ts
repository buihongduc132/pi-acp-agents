/**
 * RED test for task 6.1 — Register `acp_dag_submit` tool in index.ts.
 *
 * Behavior under test: the tool must
 *  1. be registered with name `acp_dag_submit`
 *  2. accept `{tasks, args?, options?}` parameters
 *  3. validate via DagValidator; on failure return a `DAG validation failed:`
 *     error string WITHOUT calling DagStore.create or DagExecutor.execute
 *  4. on success call DagStore.create() with the submitted definition
 *  5. kick off DagExecutor.execute() in the background (fire-and-forget)
 *  6. return `{dagId}` content with the new DAG id
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
vi.mock("../src/core/async-executor.js", () => ({
	AsyncExecutor: vi.fn(),
}));
vi.mock("../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));

// DagStore / DagValidator / DagExecutor / TemplateResolver are spied so we can
// assert the tool wires them together correctly.
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

describe("acp_dag_submit tool (task 6.1)", () => {
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
		dispose: vi.fn(),
			},
			// DAG mocks
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

	it("registers the acp_dag_submit tool", () => {
		expect(tools.has("acp_dag_submit")).toBe(true);
	});

	it("exposes tasks/args/options parameters", () => {
		const params = (tools.get("acp_dag_submit")?.parameters as any)?.properties ?? {};
		expect(params).toHaveProperty("tasks");
		expect(params).toHaveProperty("args");
		expect(params).toHaveProperty("options");
	});

	it("validates via DagValidator and rejects invalid DAGs without creating them", async () => {
		m.dagValidator.validate.mockReturnValueOnce({
			valid: false,
			errors: ['duplicate step ID: "research"'],
		});
		const r = await exec("acp_dag_submit", {
			tasks: [
				{ id: "research", agent: "gemini", prompt: "x" },
				{ id: "research", agent: "gemini", prompt: "x" },
			],
		});
		expect(r.content[0].text).toContain("DAG validation failed");
		expect(r.content[0].text).toContain('duplicate step ID: "research"');
		expect(m.dagStore.create).not.toHaveBeenCalled();
		expect(m.dagExecutor.execute).not.toHaveBeenCalled();
	});

	it("creates the DAG via DagStore.create, kicks off executor in the background, returns dagId", async () => {
		const tasks = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
			{ id: "b", agent: "claude", prompt: "Code based on {a.output}", dependsOn: ["a"] },
		];
		const args = { topic: "authentication" };
		const options = { failFast: false, maxRetries: 1 };
		const r = await exec("acp_dag_submit", { tasks, args, options });

		// DagStore.create called with the submitted definition
		expect(m.dagStore.create).toHaveBeenCalledTimes(1);
		expect(m.dagStore.create).toHaveBeenCalledWith(expect.objectContaining({ tasks, args, options }));

		// DagExecutor.execute kicked off (fire-and-forget background)
		expect(m.dagExecutor.execute).toHaveBeenCalledTimes(1);
		expect(m.dagExecutor.execute).toHaveBeenCalledWith("dag-uuid-1234");

		// Response returns the dagId
		expect(r.details).toMatchObject({ dagId: "dag-uuid-1234" });
		expect(r.content[0].text).toContain("dag-uuid-1234");
	});
});

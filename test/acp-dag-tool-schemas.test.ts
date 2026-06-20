/**
 * RED test for task 6.4 — Add tool parameter schemas using TypeBox.
 *
 * Task 6.4 pins the EXACT TypeBox parameter schema shape for the three DAG
 * tools registered in index.ts. This test locks in that contract:
 *
 *   acp_dag_submit:
 *     - tasks: REQUIRED Array<Object<{id, agent, prompt, dependsOn?, gate?}>>
 *       - id, agent, prompt REQUIRED (string)
 *       - dependsOn OPTIONAL (Array<string>)
 *       - gate OPTIONAL (Union[Literal("needs"), Literal("after")])
 *     - args: OPTIONAL Record<string, string>
 *     - options: OPTIONAL Object<{failFast?: boolean, maxRetries?: number}>
 *
 *   acp_dag_status:
 *     - dagId: OPTIONAL string (omit → list mode)
 *
 *   acp_dag_cancel:
 *     - dagId: REQUIRED string
 *
 * TypeBox 1.x emits plain JSON-Schema objects: optionality is encoded by
 * absence from the `required` array, unions via `anyOf`, and records via
 * `patternProperties`. We assert against that emitted shape.
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
vi.mock("../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));
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
import { DagValidator } from "../src/dag/dag-validator.js";
import { DagExecutor } from "../src/dag/dag-executor.js";
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

function mkSM() {
	return {
		add: vi.fn(),
		get: vi.fn(),
		list: vi.fn(() => []),
		listByAgent: vi.fn(() => []),
		remove: vi.fn(),
		disposeAll: vi.fn(),
		pruneStale: vi.fn(async () => ({ removedSessionIds: [] })),
		size: 0,
	};
}

describe("DAG tool parameter schemas (task 6.4)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		const stubs = {
			sm: mkSM(),
			ts: { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) },
			gs: { getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(), getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) },
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), isHealthy: vi.fn(() => true), recordSuccess: vi.fn(), recordFailure: vi.fn(), state: "closed" },
			hm: { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() },
			ad: { spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "ses-1"), loadSession: vi.fn(), prompt: vi.fn(async () => ({ text: "r", stopReason: "end_turn", sessionId: "ses-1" })), setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn() },
			co: { delegate: vi.fn(async () => ({ text: "d", stopReason: "end_turn", sessionId: "d1" })), broadcast: vi.fn(async () => []), compare: vi.fn(async () => ({ responses: [], timestamp: new Date().toISOString() })) },
			dagStore: { create: vi.fn((d: any) => ({ dagId: "dag-1", ...d })), get: vi.fn(), updateStep: vi.fn(), updateDagStatus: vi.fn(), listAll: vi.fn(() => []), findRunning: vi.fn(() => []) },
			dagValidator: { validate: vi.fn(() => ({ valid: true, errors: [] })) },
			dagExecutor: { execute: vi.fn(async () => undefined), cancel: vi.fn(async () => ({ completed: 0, aborted: 0, cancelled: 0 })), resumeAll: vi.fn(async () => []) },
			templateResolver: { resolve: vi.fn((p: string) => p) },
		};
		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function () { return stubs.sm; });
		(AcpTaskStore as any).mockImplementation(function () { return stubs.ts; });
		(MailboxManager as any).mockImplementation(function () { return stubs.mb; });
		(GovernanceStore as any).mockImplementation(function () { return stubs.gs; });
		(AcpEventLog as any).mockImplementation(function () { return stubs.el; });
		(AcpCircuitBreaker as any).mockImplementation(function () { return stubs.cb; });
		(HealthMonitor as any).mockImplementation(function () { return stubs.hm; });
		(createAdapter as any).mockImplementation(function () { return stubs.ad; });
		(AgentCoordinator as any).mockImplementation(function () { return stubs.co; });
		(DagStore as any).mockImplementation(function () { return stubs.dagStore; });
		(DagValidator as any).mockImplementation(function () { return stubs.dagValidator; });
		(DagExecutor as any).mockImplementation(function () { return stubs.dagExecutor; });
		(TemplateResolver as any).mockImplementation(function () { return stubs.templateResolver; });

		main({
			registerTool: vi.fn((t: any) => tools.set(t.name, t)),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
	});

	const paramsOf = (name: string): any => tools.get(name)!.parameters;

	describe("acp_dag_submit schema", () => {
		it("declares `tasks` as a REQUIRED top-level field, and `args`/`options` as OPTIONAL", () => {
			const schema = paramsOf("acp_dag_submit");
			expect(Array.isArray(schema.required)).toBe(true);
			expect(schema.required).toContain("tasks");
			expect(schema.required).not.toContain("args");
			expect(schema.required).not.toContain("options");
		});

		it("declares tasks as an array of objects with the required id/agent/prompt fields", () => {
			const tasks = paramsOf("acp_dag_submit").properties.tasks;
			expect(tasks.type).toBe("array");
			const item = tasks.items;
			expect(item.type).toBe("object");
			expect(item.properties).toHaveProperty("id");
			expect(item.properties).toHaveProperty("agent");
			expect(item.properties).toHaveProperty("prompt");
			expect(item.properties.id.type).toBe("string");
			expect(item.properties.agent.type).toBe("string");
			expect(item.properties.prompt.type).toBe("string");
			// id/agent/prompt are required on each task item
			expect(item.required).toEqual(expect.arrayContaining(["id", "agent", "prompt"]));
		});

		it("declares dependsOn as an OPTIONAL Array<string>", () => {
			const item = paramsOf("acp_dag_submit").properties.tasks.items;
			expect(item.properties.dependsOn.type).toBe("array");
			expect(item.properties.dependsOn.items.type).toBe("string");
			expect(item.required ?? []).not.toContain("dependsOn");
		});

		it("declares gate as an OPTIONAL union of literals 'needs' | 'after'", () => {
			const item = paramsOf("acp_dag_submit").properties.tasks.items;
			const gate = item.properties.gate;
			expect(gate.anyOf).toBeInstanceOf(Array);
			const consts = gate.anyOf.map((m: any) => m.const).sort();
			expect(consts).toEqual(["after", "needs"]);
			expect(item.required ?? []).not.toContain("gate");
		});

		it("declares args as a Record<string, string> (patternProperties → string)", () => {
			const args = paramsOf("acp_dag_submit").properties.args;
			expect(args.type).toBe("object");
			expect(args.patternProperties).toBeDefined();
			const pat = args.patternProperties[Object.keys(args.patternProperties)[0]];
			expect(pat.type).toBe("string");
		});

		it("declares options as an Object<failFast?: boolean, maxRetries?: number> (both optional)", () => {
			const options = paramsOf("acp_dag_submit").properties.options;
			expect(options.type).toBe("object");
			expect(options.properties.failFast.type).toBe("boolean");
			expect(options.properties.maxRetries.type).toBe("number");
			expect(options.required ?? []).not.toContain("failFast");
			expect(options.required ?? []).not.toContain("maxRetries");
		});
	});

	describe("acp_dag_status schema", () => {
		it("declares dagId as an OPTIONAL string", () => {
			const schema = paramsOf("acp_dag_status");
			expect(schema.properties.dagId.type).toBe("string");
			expect(schema.required ?? []).not.toContain("dagId");
		});
	});

	describe("acp_dag_cancel schema", () => {
		it("declares dagId as a REQUIRED string", () => {
			const schema = paramsOf("acp_dag_cancel");
			expect(schema.properties.dagId.type).toBe("string");
			expect(Array.isArray(schema.required)).toBe(true);
			expect(schema.required).toContain("dagId");
		});
	});
});

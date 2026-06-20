/**
 * Task 8.1 — Smoke test: end-to-end DAG execution via the real tool surface.
 *
 * Behavior under test (specs/dag-submission "DAG submission via single tool
 * call" + specs/dag-monitoring "DAG status query returns full state"):
 *
 *   1. `acp_dag_submit` accepts a 2-step linear DAG (research → code),
 *      validates it, persists it, kicks off background wave execution,
 *      and returns a `dagId` immediately.
 *   2. Wave 1 (research) dispatches to the assigned agent and captures its
 *      output.
 *   3. Wave 2 (code) executes only after wave 1 completes, and its prompt
 *      receives the resolved `{research.output}` template variable.
 *   4. `acp_dag_status` returns the full DAG state once execution finishes:
 *      status `completed`, both steps `completed` with populated outputs,
 *      correct wave progress, and persisted on disk.
 *
 * The test exercises the real `DagStore`, `DagValidator`, `DagExecutor`, and
 * `TemplateResolver` through the tool handlers registered by `index.ts`.
 * Only the leaf-level agent transport (`AgentCoordinator.delegate`) and
 * unrelated session/runtime infrastructure are mocked, so this is a true
 * tool-surface → executor → persistence → status-query round trip.
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
	createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../../src/core/async-executor.js", () => ({ AsyncExecutor: vi.fn() }));
vi.mock("../../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));

// Shared mock coordinator: captures every delegated prompt and returns a
// canned response keyed off the prompt content so wave 2 can verify template
// resolution end-to-end.
const { makeCoordinator, delegateSpy } = vi.hoisted(() => {
	const delegateSpy = vi.fn();
	const makeCoordinator = () => ({
		delegate: delegateSpy,
		broadcast: vi.fn(async () => []),
		compare: vi.fn(async () => ({ responses: [], timestamp: new Date().toISOString() })),
	});
	return { makeCoordinator, delegateSpy };
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

describe("DAG smoke — acp_dag_submit + acp_dag_status (task 8.1)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-smoke-"));
		delegateSpy.mockClear();

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

	it("executes a 2-step linear DAG (research → code) end-to-end", async () => {
		// The mock agent returns the research findings on the first delegate
		// call, then a code-implementation message on the second. Both calls
		// go through the real tool surface → real executor → real store.
		delegateSpy.mockImplementation(async (_agent: string, message: string) => {
			if (message === "Research authentication approaches") {
				return { text: "Use JWT tokens with RS256", stopReason: "end_turn", sessionId: "research-1" };
			}
			return { text: `Implemented based on: ${message}`, stopReason: "end_turn", sessionId: "code-1" };
		});

		// 1. Submit the DAG through the real acp_dag_submit tool.
		const submit = await exec("acp_dag_submit", {
			tasks: [
				{ id: "research", agent: "gemini", prompt: "Research authentication approaches" },
				{ id: "code", agent: "gemini", prompt: "Implement auth based on {research.output}", dependsOn: ["research"] },
			],
		});

		const dagId = submit.details.dagId;
		expect(dagId).toBeTruthy();
		expect(submit.details.stepCount).toBe(2);

		// 2. Poll acp_dag_status until the DAG reaches a terminal state.
		let details: any;
		for (let i = 0; i < 100; i++) {
			const status = await exec("acp_dag_status", { dagId });
			details = status.details;
			if (details.status === "completed" || details.status === "failed") break;
			await new Promise((r) => setTimeout(r, 20));
		}

		// 3. The DAG and every step completed.
		expect(details.status).toBe("completed");
		expect(details.dagId).toBe(dagId);

		// 4. Both waves were dispatched through the (mocked) agent transport,
		//    in order: research first, then code.
		expect(delegateSpy).toHaveBeenCalledTimes(2);
		expect(delegateSpy.mock.calls[0][1]).toBe("Research authentication approaches");
		// Template variable {research.output} resolved to the captured output.
		expect(delegateSpy.mock.calls[1][1]).toBe("Implement auth based on Use JWT tokens with RS256");

		// 5. The full state is persisted on disk (end-to-end persistence) and
		//    reflects both step outputs and statuses.
		const persisted = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
		expect(persisted.status).toBe("completed");
		expect(persisted.steps.research.status).toBe("completed");
		expect(persisted.steps.research.output).toBe("Use JWT tokens with RS256");
		expect(persisted.steps.code.status).toBe("completed");
		expect(persisted.steps.code.output).toBe("Implemented based on: Implement auth based on Use JWT tokens with RS256");
	});
});

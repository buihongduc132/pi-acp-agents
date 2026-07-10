/**
 * Task 8.7 — Smoke test: after-gate — step "a" fails, step "b" with
 * gate:"after" still executes, receiving the error message as {a.output}.
 *
 * Behavior under test:
 *   - specs/dag-submission "Gate types — needs and after",
 *     scenario "after gate proceeds regardless of dependency outcome"
 *   - specs/dag-execution "Wave-based parallel execution", gate types
 *
 * DAG shape:
 *
 *     a (fails) ──▶ b (gate: "after", depends on a)
 *
 * Expected outcome:
 *   1. "a" is dispatched and FAILS (delegate throws).
 *   2. "b" with gate:"after" IS dispatched regardless, receiving the error
 *      message as the resolved value of {a.output}.
 *   3. "b" completes successfully with its output stored.
 *   4. The DAG reaches terminal status `failed` (a step failed).
 *   5. State persisted to disk reflects these transitions.
 *
 * The test exercises the real `DagStore`, `DagValidator`, `DagExecutor`,
 * and `TemplateResolver` through the tool handlers in `index.ts`. Only the
 * leaf-level agent transport (`AgentCoordinator.delegate`) and unrelated
 * session/runtime infrastructure are mocked.
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
	createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../../src/core/async-executor.js", () => ({ AsyncExecutor: vi.fn() }));
vi.mock("../../src/acp-widget.js", () => ({
	createAcpWidget: () => () => ({ render: vi.fn() }),
}));

// Shared mock coordinator. "a" fails; "b" completes.
const { makeCoordinator, delegateSpy } = vi.hoisted(() => {
	const delegateSpy = vi.fn();
	const makeCoordinator = () => ({
		delegate: delegateSpy,
		broadcast: vi.fn(async () => []),
		compare: vi.fn(async () => ({ responses: [], timestamp: new Date().toISOString() })),
		dispose: vi.fn(),
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

describe("DAG smoke — after-gate: 'a' fails, 'b' with gate:'after' still executes (task 8.7)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-after-gate-smoke-"));
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

	it("after-gate: 'a' fails, 'b' with gate:'after' still executes and receives {a.output} as error message", async () => {
		// "a" fails; "b" completes and receives the error message as {a.output}.
		const dispatchedPrompts: string[] = [];
		delegateSpy.mockImplementation(async (_agent: string, message: string) => {
			dispatchedPrompts.push(message);
			if (message === "Research X") throw new Error("a failed");
			return { text: `Review: ${message}`, stopReason: "end_turn", sessionId: "ses-1" };
		});

		// Submit the DAG through the real tool surface with gate:"after".
		const submit = await exec("acp_dag", { action: "submit",
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Research X" },
				{
					id: "b",
					agent: "gemini",
					prompt: "Review {a.output}",
					dependsOn: ["a"],
					gate: "after",
				},
			],
		});

		const dagId = submit.details.dagId;
		expect(dagId).toBeTruthy();
		expect(submit.details.stepCount).toBe(2);

		// Poll acp_dag_status until the DAG reaches a terminal state.
		let statusSummary: any;
		let record: any;
		for (let i = 0; i < 200; i++) {
			const status = await exec("acp_dag", { action: "status", dagId });
			statusSummary = status.details;
			record = JSON.parse(status.content.map((c: any) => c.text).join(""));
			if (["completed", "failed", "cancelled"].includes(statusSummary.status)) break;
			await new Promise((r) => setTimeout(r, 20));
		}

		// 1. "a" was dispatched and FAILED.
		expect(record.steps.a.status).toBe("failed");
		expect(record.steps.a.error).toContain("a failed");
		expect(record.steps.a.output).toBeNull();

		// 2. "b" with gate:"after" WAS dispatched regardless of "a"'s failure.
		// The resolved prompt received the error message as {a.output}.
		expect(dispatchedPrompts).toHaveLength(2);
		expect(dispatchedPrompts[1]).toBe("Review a failed");

		// 3. "b" completed successfully with its output stored.
		expect(record.steps.b.status).toBe("completed");
		expect(record.steps.b.output).toBe("Review: Review a failed");

		// 4. Both steps were dispatched — after-gate proceeds regardless.
		expect(delegateSpy).toHaveBeenCalledTimes(2);

		// 5. DAG-level status is `failed` (a step failed).
		expect(statusSummary.status).toBe("failed");
		expect(record.status).toBe("failed");

		// 6. Persisted state on disk reflects every transition.
		const persisted = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
		expect(persisted.status).toBe("failed");
		expect(persisted.steps.a.status).toBe("failed");
		expect(persisted.steps.a.error).toContain("a failed");
		expect(persisted.steps.a.output).toBeNull();
		expect(persisted.steps.b.status).toBe("completed");
		expect(persisted.steps.b.output).toBe("Review: Review a failed");
	});
});

/**
 * Task 8.6 — Smoke test: failFast skips transitive dependents, independent
 * branches complete, via the real tool surface.
 *
 * Behavior under test:
 *   - specs/dag-submission "DAG options — failFast and maxRetries",
 *     scenario "failFast=true skips dependents of failed step"
 *   - specs/dag-execution "DAG state transitions",
 *     scenario "Step transitions to skipped when dependency fails (failFast)"
 *
 * DAG shape (failFast defaults to true):
 *
 *     a (fails) ──▶ b (needs a) ──▶ c (needs b)
 *
 *     d (independent)  → completes regardless
 *
 * Expected outcome:
 *   1. "a" is dispatched and FAILS (delegate throws).
 *   2. "b" and "c" (transitive dependents of "a" via needs gates) are
 *      marked `skipped` — they are NEVER dispatched.
 *   3. "d" (independent branch) completes normally with its output stored.
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

// Shared mock coordinator. "a" fails; "d" completes. "b"/"c" must never be
// dispatched because failFast skips them.
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

describe("DAG smoke — failFast skips dependents, independent branch completes (task 8.6)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-failfast-smoke-"));
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

	it("failFast=true: 'a' fails, dependents 'b'/'c' skipped, independent 'd' completes", async () => {
		// "a" fails; every other dispatched step returns a normal output.
		delegateSpy.mockImplementation(async (_agent: string, message: string) => {
			if (message === "Step A") throw new Error("a boom");
			return { text: `out:${message}`, stopReason: "end_turn", sessionId: "ses-1" };
		});

		// Submit the DAG through the real tool surface. failFast defaults to
		// true — no explicit options needed.
		const submit = await exec("acp_dag_submit", {
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "gemini", prompt: "Step B", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "Step C", dependsOn: ["b"] },
				{ id: "d", agent: "gemini", prompt: "Step D" },
			],
		});

		const dagId = submit.details.dagId;
		expect(dagId).toBeTruthy();
		expect(submit.details.stepCount).toBe(4);

		// Poll acp_dag_status until the DAG reaches a terminal state.
		// `details` carries status/wave summary; the full record (incl. steps)
		// is serialized in the tool `content`.
		let statusSummary: any;
		let record: any;
		for (let i = 0; i < 200; i++) {
			const status = await exec("acp_dag_status", { dagId });
			statusSummary = status.details;
			record = JSON.parse(status.content.map((c: any) => c.text).join(""));
			if (["completed", "failed", "cancelled"].includes(statusSummary.status)) break;
			await new Promise((r) => setTimeout(r, 20));
		}

		// 1. "a" was dispatched and FAILED.
		expect(record.steps.a.status).toBe("failed");
		expect(record.steps.a.error).toContain("a boom");
		expect(record.steps.a.output).toBeNull();

		// 2. "b" and "c" (transitive dependents via needs gates) are skipped
		//    and were NEVER dispatched.
		expect(record.steps.b.status).toBe("skipped");
		expect(record.steps.c.status).toBe("skipped");

		// 3. "d" (independent branch) completed normally with stored output.
		expect(record.steps.d.status).toBe("completed");
		expect(record.steps.d.output).toBe("out:Step D");

		// 4. Only "a" and "d" were dispatched — "b"/"c" skipped, never run.
		expect(delegateSpy).toHaveBeenCalledTimes(2);

		// 5. DAG-level status is `failed` (a step failed under failFast).
		expect(statusSummary.status).toBe("failed");
		expect(record.status).toBe("failed");

		// 6. Persisted state on disk reflects every transition.
		const persisted = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
		expect(persisted.status).toBe("failed");
		expect(persisted.steps.a.status).toBe("failed");
		expect(persisted.steps.a.error).toContain("a boom");
		expect(persisted.steps.a.output).toBeNull();
		expect(persisted.steps.b.status).toBe("skipped");
		expect(persisted.steps.c.status).toBe("skipped");
		expect(persisted.steps.d.status).toBe("completed");
		expect(persisted.steps.d.output).toBe("out:Step D");
	});
});

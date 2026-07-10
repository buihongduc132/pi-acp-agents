/**
 * Task 8.3 — Smoke test: end-to-end DAG cancellation via the real tool
 * surface.
 *
 * Behavior under test (specs/dag-monitoring "DAG cancellation"):
 *
 *   1. `acp_dag_submit` starts a 3-step linear DAG (a → b → c).
 *   2. Step "a" completes immediately; step "b" blocks in-flight until its
 *      abort signal fires; step "c" stays `pending`.
 *   3. After step "a" completes, `acp_dag_cancel` is called.
 *   4. The cancel tool aborts the in-flight "b" session, marks the pending
 *      "c" step as `cancelled`, transitions the DAG to `cancelled`, and
 *      returns a summary `{completed: 1, aborted: 1, cancelled: 1}`.
 *   5. The persisted DAG state on disk reflects the cancellation outcome.
 *
 * The test exercises the real `DagStore`, `DagValidator`, `DagExecutor`, and
 * `TemplateResolver` through the tool handlers registered by `index.ts`.
 * Only the leaf-level agent transport (`AgentCoordinator.delegate`) and
 * unrelated session/runtime infrastructure are mocked.
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

// Shared mock coordinator: step "a" returns a canned response immediately;
// step "b" blocks until its abort signal fires (mirroring an in-flight
// agent session that cancel() must abort).
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

describe("DAG smoke — acp_dag_cancel (task 8.3)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-cancel-smoke-"));
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

	it("cancels a running 3-step DAG after step 1 completes", async () => {
		// Step "a" completes immediately; step "b" blocks until its abort
		// signal fires; step "c" is never dispatched (it's pending, blocked
		// on "b").
		let bSignal: AbortSignal | undefined;
		delegateSpy.mockImplementation(
			async (_agent: string, message: string, _cwd?: string, _onProgress?: unknown, signal?: AbortSignal) => {
				if (message === "Step A") {
					return { text: "a-output", stopReason: "end_turn", sessionId: "a-1" };
				}
				// Step "b" (and any later) blocks in-flight until cancelled.
				bSignal = signal;
				return new Promise((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Operation cancelled", "AbortError")),
						{ once: true },
					);
				});
			},
		);

		// 1. Submit the 3-step linear DAG through the real tool surface.
		const submit = await exec("acp_dag", { action: "submit",
			tasks: [
				{ id: "a", agent: "gemini", prompt: "Step A" },
				{ id: "b", agent: "gemini", prompt: "Step B based on {a.output}", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "Step C based on {b.output}", dependsOn: ["b"] },
			],
		});
		const dagId = submit.details.dagId;
		expect(dagId).toBeTruthy();

		// 2. Wait for step "a" to complete and step "b" to enter flight.
		await vi.waitFor(() => expect(bSignal).toBeTruthy());
		// Confirm "a" actually completed in the persisted state before we
		// cancel — this is the "cancel after step 1 completes" precondition.
		await vi.waitFor(() => {
			const st = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
			expect(st.steps.a.status).toBe("completed");
		});

		// 3. Cancel the DAG through the real tool surface.
		const cancel = await exec("acp_dag", { action: "cancel", dagId });

		// 4. Summary reflects: 1 completed (a), 1 aborted (b in-flight),
		//    1 cancelled (c pending).
		expect(cancel.details).toEqual({ dagId, completed: 1, aborted: 1, cancelled: 1 });
		expect(bSignal!.aborted).toBe(true);

		// 5. The in-flight "b" dispatch was rejected by the abort; let the
		//    executor's wave loop settle.
		await new Promise((r) => setTimeout(r, 20));

		// 6. Persisted state reflects the cancellation outcome.
		const persisted = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
		expect(persisted.status).toBe("cancelled");
		expect(persisted.steps.a.status).toBe("completed");
		expect(persisted.steps.a.output).toBe("a-output");
		expect(persisted.steps.b.status).toBe("cancelled");
		expect(persisted.steps.c.status).toBe("cancelled");

		// 7. The status tool confirms the cancelled state end-to-end.
		const status = await exec("acp_dag", { action: "status", dagId });
		expect(status.details.status).toBe("cancelled");
	});
});

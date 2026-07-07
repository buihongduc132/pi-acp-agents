/**
 * Task 8.8 — Smoke test: DAG listing via the real tool surface.
 *
 * Behavior under test (specs/dag-monitoring "DAG listing", scenario
 * "List all DAGs"):
 *
 *   1. Submit two distinct DAGs through `acp_dag_submit`.
 *   2. Call `acp_dag_status` WITHOUT a `dagId`.
 *   3. The response SHALL list both DAGs with summary fields:
 *      `dagId`, `status`, `totalSteps`, `completedSteps`,
 *      `failedSteps`, `createdAt`, `updatedAt`.
 *
 * Only the leaf-level agent transport (`AgentCoordinator.delegate`) and
 * unrelated session/runtime infrastructure are mocked, so this exercises
 * the real tool surface → `DagStore` index → status-query listing path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

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

describe("DAG smoke — acp_dag_status listing (task 8.8)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-listing-"));
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

	it("lists both DAGs when acp_dag_status is called without dagId", async () => {
		// Simple canned response so every step completes.
		delegateSpy.mockImplementation(async (_agent: string, _message: string) => ({
			text: "ok",
			stopReason: "end_turn",
			sessionId: "ses-1",
		}));

		// 1. Submit two distinct DAGs.
		const submit1 = await exec("acp_dag_submit", {
			tasks: [
				{ id: "research", agent: "gemini", prompt: "Research authentication" },
				{ id: "code", agent: "gemini", prompt: "Implement based on {research.output}", dependsOn: ["research"] },
			],
		});
		const dagId1 = submit1.details.dagId;

		const submit2 = await exec("acp_dag_submit", {
			tasks: [
				{ id: "research", agent: "gemini", prompt: "Research caching" },
			],
		});
		const dagId2 = submit2.details.dagId;

		expect(dagId1).toBeTruthy();
		expect(dagId2).toBeTruthy();
		expect(dagId1).not.toBe(dagId2);

		// 2. Poll each DAG to terminal state so the index reflects final
		//    completed/failed step counts.
		const waitForTerminal = async (dagId: string) => {
			for (let i = 0; i < 100; i++) {
				const status = await exec("acp_dag_status", { dagId });
				if (status.details.status === "completed" || status.details.status === "failed") return;
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		await waitForTerminal(dagId1);
		await waitForTerminal(dagId2);

		// 3. Call acp_dag_status WITHOUT a dagId → listing mode.
		const listing = await exec("acp_dag_status", {});

		// 4. Both DAGs are present in the list.
		const dags = listing.details.dags as any[];
		expect(Array.isArray(dags)).toBe(true);
		expect(dags.length).toBe(2);
		expect(listing.details.count).toBe(2);

		const ids = dags.map((d) => d.dagId).sort();
		expect(ids).toEqual([dagId1, dagId2].sort());

		// 5. Each entry carries the full summary shape declared by the spec.
		const byId = new Map(dags.map((d) => [d.dagId, d] as const));
		for (const id of [dagId1, dagId2]) {
			const entry = byId.get(id)!;
			expect(entry.dagId).toBe(id);
			expect(typeof entry.status).toBe("string");
			expect(typeof entry.totalSteps).toBe("number");
			expect(typeof entry.completedSteps).toBe("number");
			expect(typeof entry.failedSteps).toBe("number");
			expect(typeof entry.createdAt).toBe("string");
			expect(typeof entry.updatedAt).toBe("string");
		}

		// 6. Step counts reflect the actual DAG shapes (2 vs 1 step), and
		//    both completed fully.
		const e1 = byId.get(dagId1)!;
		const e2 = byId.get(dagId2)!;
		expect(e1.totalSteps).toBe(2);
		expect(e1.completedSteps).toBe(2);
		expect(e1.failedSteps).toBe(0);
		expect(e1.status).toBe("completed");
		expect(e2.totalSteps).toBe(1);
		expect(e2.completedSteps).toBe(1);
		expect(e2.failedSteps).toBe(0);
		expect(e2.status).toBe("completed");
	});
});

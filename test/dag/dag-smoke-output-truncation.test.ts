/**
 * Task 8.9 — Smoke test: end-to-end output truncation.
 *
 * Behavior under test (specs/dag-execution "Template variable resolution",
 * scenario "Truncate large outputs"):
 *
 *   - WHEN step "a" output is 15000 characters and the truncation limit is
 *     8000 characters
 *   - THEN the resolved `{a.output}` in downstream prompts SHALL be the
 *     first 8000 characters followed by
 *     `\n\n[... output truncated, 7000 chars omitted ...]`.
 *
 * This is a true tool-surface round trip: `acp_dag_submit` → real
 * `DagExecutor` → real `TemplateResolver` (wired with the default
 * 8000-char limit from `dagOutputTruncateChars`) → real `DagStore`
 * persistence → mock agent transport that records every delegated prompt.
 * Only the leaf transport (`AgentCoordinator.delegate`) and unrelated
 * session/runtime plumbing are mocked.
 *
 * Distinct from task 4.6 (unit-level truncation in TemplateResolver): this
 * test pins the end-to-end contract that the *downstream agent's dispatched
 * prompt* receives the truncated upstream output — i.e. truncation actually
 * fires inside the real wave-dispatch path, not just inside the resolver in
 * isolation. It also verifies that the full (untruncated) output is what the
 * step captures and persists, while only the *injected* `{a.output}` value
 * is truncated — so design.md R1 (context-window protection) is honoured at
 * the dispatch boundary without data loss in the DAG state file.
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

// Shared mock coordinator: records every delegated prompt verbatim and
// returns a >8000-char output for step 1 so the downstream step 2 must
// receive the *truncated* value via {step1.output}.
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

/**
 * Helper: poll acp_dag_status until the DAG reaches a terminal state
 * (completed/failed/cancelled), returning the final details object.
 */
async function waitForTerminal(
	tools: Map<string, any>,
	exec: (n: string, p: any) => any,
	dagId: string,
) {
	for (let i = 0; i < 100; i++) {
		const status = await exec("acp_dag_status", { dagId });
		if (["completed", "failed", "cancelled"].includes(status.details.status)) {
			return status.details;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`DAG ${dagId} did not reach a terminal state in time`);
}

describe("DAG smoke — output truncation (task 8.9)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-trunc-"));
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

	it("step 1 produces >8000-char output; step 2's {step1.output} receives the truncated form", async () => {
		// 15000-char upstream output (spec scenario). Step 1 returns it;
		// step 2 echoes its received prompt back so we can assert the
		// resolved (truncated) text end-to-end.
		const TRUNCATE_LIMIT = 8_000;
		const LONG_OUTPUT = "x".repeat(15_000);
		const OMISSION_MARKER = `\n\n[... output truncated, 7000 chars omitted ...]`;
		const EXPECTED_TRUNCATED = "x".repeat(TRUNCATE_LIMIT) + OMISSION_MARKER;

		delegateSpy.mockImplementation(async (_agent: string, message: string) => {
			if (message === "Generate a long report") {
				return { text: LONG_OUTPUT, stopReason: "end_turn", sessionId: "step1-1" };
			}
			return { text: `ECHO>> ${message}`, stopReason: "end_turn", sessionId: "step2-1" };
		});

		// Submit a 2-step linear DAG whose step-2 prompt carries the literal
		// {step1.output} placeholder. The default dagOutputTruncateChars
		// (8000) is wired into the resolver at extension load.
		const submit = await exec("acp_dag_submit", {
			tasks: [
				{ id: "step1", agent: "gemini", prompt: "Generate a long report" },
				{
					id: "step2",
					agent: "gemini",
					prompt: "Summarize this: {step1.output}",
					dependsOn: ["step1"],
				},
			],
		});
		const dagId = submit.details.dagId;
		expect(dagId).toBeTruthy();

		// Wait for terminal state.
		const details = await waitForTerminal(tools, exec, dagId);
		expect(details.status).toBe("completed");

		// Exactly two delegate calls — step 1 then step 2.
		expect(delegateSpy).toHaveBeenCalledTimes(2);

		// CORE CONTRACT: step 2's dispatched prompt carries the TRUNCATED
		// upstream output — first 8000 chars + omission marker, no leftover
		// placeholder, no full 15000 chars leaking through.
		const step2Prompt = delegateSpy.mock.calls[1][1];
		expect(step2Prompt).toBe(`Summarize this: ${EXPECTED_TRUNCATED}`);
		expect(step2Prompt).not.toContain("{step1.output}");
		expect(step2Prompt).toContain(OMISSION_MARKER);
		expect(step2Prompt.length).toBeLessThan(LONG_OUTPUT.length);

		// Data integrity: the persisted DAG state retains step 1's FULL
		// (untruncated) captured output — truncation only narrows the
		// *injected* value into step 2's prompt, it does not erase the
		// original output from the DAG state file.
		const persisted = JSON.parse(
			readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"),
		);
		expect(persisted.steps.step1.status).toBe("completed");
		expect(persisted.steps.step1.output).toBe(LONG_OUTPUT);
		expect(persisted.steps.step1.output.length).toBe(15_000);

		// Step 2's captured output is the agent's echo of the resolved
		// (truncated) prompt — proving the truncated value, not the raw
		// full output, was dispatched.
		expect(persisted.steps.step2.status).toBe("completed");
		expect(persisted.steps.step2.output).toBe(
			`ECHO>> Summarize this: ${EXPECTED_TRUNCATED}`,
		);
	});
});

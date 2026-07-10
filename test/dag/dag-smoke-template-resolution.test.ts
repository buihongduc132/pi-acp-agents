/**
 * Task 8.2 — Smoke test: end-to-end template variable resolution.
 *
 * Behavior under test (specs/dag-execution "Template variable resolution",
 * scenario "Resolve upstream step output"):
 *
 *   - step 2's prompt contains the literal template placeholder
 *     `{step1.output}`
 *   - after wave 1 completes, the executor resolves that placeholder against
 *     step 1's *actual captured output* before dispatching step 2
 *   - the resolved prompt is exactly what the downstream agent receives via
 *     `coordinator.delegate(agent, resolvedPrompt, cwd)`
 *
 * This is a true tool-surface round trip: `acp_dag_submit` → real
 * `DagExecutor` → real `TemplateResolver` → real `DagStore` persistence →
 * mock agent transport that records every delegated prompt. Only the leaf
 * transport (`AgentCoordinator.delegate`) and unrelated session/runtime
 * plumbing are mocked.
 *
 * Distinct from task 8.1 (which checks one resolved prompt as part of a
 * broader linear-DAG smoke test): this file isolates the template-resolution
 * contract across several shapes so that a regression in the resolver cannot
 * hide behind other executor behavior. It pins:
 *   1. the literal placeholder survives submission/validation unchanged
 *      (i.e. it is NOT pre-resolved at submit time before step 1 runs);
 *   2. step 2's dispatched prompt contains step 1's actual output verbatim;
 *   3. the placeholder is fully consumed (no leftover `{...}` text leaks
 *      into the downstream agent prompt);
 *   4. multiple `{<id>.output}` references in a single prompt resolve
 *      independently against their respective upstream outputs.
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
// returns canned, prompt-keyed output so template resolution can be verified
// end-to-end across waves.
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
async function waitForTerminal(tools: Map<string, any>, exec: (n: string, p: any) => any, dagId: string) {
	for (let i = 0; i < 100; i++) {
		const status = await exec("acp_dag", { action: "status", dagId });
		if (["completed", "failed", "cancelled"].includes(status.details.status)) {
			return status.details;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`DAG ${dagId} did not reach a terminal state in time`);
}

describe("DAG smoke — template variable resolution (task 8.2)", () => {
	let tools: Map<string, any>;

	beforeEach(() => {
		tools = new Map();
		runtimeRoot.value = mkdtempSync(join(tmpdir(), "dag-tmpl-"));
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

	it("step 2 prompt containing {step1.output} receives step 1's actual output", async () => {
		// The mock agent returns a deterministic, recognizable string for
		// step 1; for step 2 it echoes back exactly the prompt it received
		// so we can assert against the resolved text downstream.
		const STEP1_OUTPUT = "Use JWT tokens with RS256 and refresh every 15m";
		delegateSpy.mockImplementation(async (_agent: string, message: string) => {
			if (message === "Research authentication approaches") {
				return { text: STEP1_OUTPUT, stopReason: "end_turn", sessionId: "step1-1" };
			}
			return { text: `ECHO>> ${message}`, stopReason: "end_turn", sessionId: "step2-1" };
		});

		// 1. Submit a 2-step linear DAG whose step-2 prompt carries the
		//    literal {step1.output} placeholder.
		const submit = await exec("acp_dag", { action: "submit",
			tasks: [
				{ id: "step1", agent: "gemini", prompt: "Research authentication approaches" },
				{
					id: "step2",
					agent: "gemini",
					prompt: "Implement auth based on {step1.output}",
					dependsOn: ["step1"],
				},
			],
		});
		const dagId = submit.details.dagId;
		expect(dagId).toBeTruthy();

		// 2. Wait for terminal state.
		const details = await waitForTerminal(tools, exec, dagId);
		expect(details.status).toBe("completed");

		// 3. step 1 ran first, step 2 ran second, exactly once each.
		expect(delegateSpy).toHaveBeenCalledTimes(2);
		expect(delegateSpy.mock.calls[0][1]).toBe("Research authentication approaches");

		// 4. CORE CONTRACT: step 2's dispatched prompt has the placeholder
		//    replaced with step 1's ACTUAL output — verbatim, no leftover
		//    `{step1.output}` text, no truncation (output is short).
		const step2Prompt = delegateSpy.mock.calls[1][1];
		expect(step2Prompt).toBe(`Implement auth based on ${STEP1_OUTPUT}`);
		expect(step2Prompt).not.toContain("{step1.output}");
		expect(step2Prompt).toContain(STEP1_OUTPUT);

		// 5. The persisted DAG state reflects the resolved dispatch:
		//    step 1's captured output is exactly STEP1_OUTPUT, and step 2's
		//    captured output is the agent's echo of the resolved prompt
		//    (proving the resolved prompt — not the raw template — was sent).
		const persisted = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
		expect(persisted.steps.step1.status).toBe("completed");
		expect(persisted.steps.step1.output).toBe(STEP1_OUTPUT);
		expect(persisted.steps.step2.status).toBe("completed");
		expect(persisted.steps.step2.output).toBe(`ECHO>> Implement auth based on ${STEP1_OUTPUT}`);
	});

	it("multiple {<id>.output} references in one prompt resolve independently", async () => {
		// Two independent source steps feed a sink step whose prompt carries
		// BOTH references. Each must resolve against its own upstream output.
		delegateSpy.mockImplementation(async (_agent: string, message: string) => {
			if (message === "List backend frameworks") {
				return { text: "Express", stopReason: "end_turn", sessionId: "be-1" };
			}
			if (message === "List frontend frameworks") {
				return { text: "React", stopReason: "end_turn", sessionId: "fe-1" };
			}
			return { text: `ECHO>> ${message}`, stopReason: "end_turn", sessionId: "sink-1" };
		});

		const submit = await exec("acp_dag", { action: "submit",
			tasks: [
				{ id: "backend", agent: "gemini", prompt: "List backend frameworks" },
				{ id: "frontend", agent: "gemini", prompt: "List frontend frameworks" },
				{
					id: "sink",
					agent: "gemini",
					prompt: "Backend: {backend.output}; Frontend: {frontend.output}",
					dependsOn: ["backend", "frontend"],
				},
			],
		});
		const dagId = submit.details.dagId;

		const details = await waitForTerminal(tools, exec, dagId);
		expect(details.status).toBe("completed");

		// The sink prompt is the 3rd delegate call and must contain BOTH
		// resolved outputs, in order, with no leftover placeholders.
		const sinkCall = delegateSpy.mock.calls.find(
			(c: any[]) => typeof c[1] === "string" && c[1].startsWith("Backend:"),
		);
		expect(sinkCall).toBeTruthy();
		expect(sinkCall![1]).toBe("Backend: Express; Frontend: React");
		expect(sinkCall![1]).not.toContain("{backend.output}");
		expect(sinkCall![1]).not.toContain("{frontend.output}");

		// Persisted sink output echoes the fully-resolved prompt.
		const persisted = JSON.parse(readFileSync(join(runtimeRoot.value, "dag", `${dagId}.json`), "utf8"));
		expect(persisted.steps.sink.output).toBe("ECHO>> Backend: Express; Frontend: React");
	});
});

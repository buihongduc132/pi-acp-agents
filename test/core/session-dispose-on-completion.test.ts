/**
 * RED test — Pillar A (dispose-on-completion).
 *
 * Drives the REAL (un-mocked) SessionManager + HealthMonitor through the
 * registered `acp_spawn` tool with a fake adapter and `idleTtlMs: 0` (one-shot).
 * After the tool resolves, the ephemeral session must be fully torn down:
 *   - sessionMgr.size === 0 (session removed)
 *   - the handle is gone from the registry
 *   - handle.disposed === true
 *
 * Under the unified surface, the old `acp_prompt { dispose: true }` one-shot
 * semantics are expressed as `acp_spawn { prompt, idleTtlMs: 0 }`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpSessionHandle } from "../../src/config/types.js";

// Mock the peripheral collaborators (filesystem-touching managers, config,
// circuit breaker, coordinator, widget, logger, adapter factory) but keep
// SessionManager + HealthMonitor REAL.
vi.mock("../../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
vi.mock("../../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class MockSessionArchiveStore {
		store = new Map<string, AcpSessionHandle>();
		get = (sessionId: string) => this.store.get(sessionId);
		upsert = (session: AcpSessionHandle) => { this.store.set(session.sessionId, session); return session; };
	},
}));
vi.mock("../../src/management/session-name-store.js", () => ({
	SessionNameStore: class MockSessionNameStore {
		byName = new Map<string, string>();
		byId = new Map<string, string>();
		getSessionId = (name: string) => this.byName.get(name);
		getName = (id: string) => this.byId.get(id);
		register = (name: string, id: string) => { this.byName.set(name, id); this.byId.set(id, name); return { name, id }; };
	},
}));
vi.mock("../../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));
vi.mock("../../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime", tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json", governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl", sessionArchiveFile: "/mock/runtime/session-archive.json",
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json",
		dagDir: "/mock/runtime/dags", dagIndexFile: "/mock/runtime/dag-index.json",
	}),
}));
vi.mock("../../src/logger.js", () => ({
	createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
	createNoopLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../../src/core/circuit-breaker.js", () => ({
	AcpCircuitBreaker: class {
		state = "closed";
		execute = async (fn: () => any) => fn();
	},
}));
vi.mock("../../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../../src/coordination/coordinator.js", () => ({ AgentCoordinator: vi.fn() }));
vi.mock("../../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: vi.fn() }) }));

import main from "../../index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { loadConfig } from "../../src/config/config.js";
import { AcpTaskStore } from "../../src/management/task-store.js";
import { MailboxManager } from "../../src/management/mailbox-manager.js";
import { GovernanceStore } from "../../src/management/governance-store.js";
import { AcpEventLog } from "../../src/management/event-log.js";
import { createAdapter } from "../../src/adapter-factory.js";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";

const CFG = {
	agent_servers: { gemini: { command: "gemini", args: ["--acp"] } },
	defaultAgent: "gemini",
	staleTimeoutMs: 3_600_000,
	circuitBreakerMaxFailures: 3,
	circuitBreakerResetMs: 60_000,
	modelPolicy: {},
};

describe("acp_spawn one-shot (idleTtlMs:0) dispose-on-completion (T1)", () => {
	let tools: Map<string, any>;
	let fakeAdapter: any;
	let capturedHandle: AcpSessionHandle | undefined;
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	beforeEach(() => {
		// Reset any spies/mock-implementations left over from the previous
		// iteration (notably the SessionManager.prototype.add spy below, which
		// otherwise stacks across tests and causes infinite recursion).
		vi.restoreAllMocks();
		tools = new Map();
		capturedHandle = undefined;

		fakeAdapter = {
			spawn: vi.fn(async () => {}),
			initialize: vi.fn(async () => {}),
			newSession: vi.fn(async () => "ses-ephemeral"),
			prompt: vi.fn(async () => ({ text: "ephemeral response", stopReason: "end_turn", sessionId: "ses-ephemeral" })),
			setModel: vi.fn(async () => {}),
			setMode: vi.fn(async () => {}),
			cancel: vi.fn(async () => {}),
			dispose: vi.fn(),
		};

		// Mocked manager instances (real SessionManager/HealthMonitor come from index.ts)
		const ts: any = { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn() };
		const mb: any = { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn() };
		const gs: any = { getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(), getPlanStatus: vi.fn(), getModelPolicy: vi.fn(() => ({})), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true })) };
		const el: any = { append: vi.fn() };

		(loadConfig as any).mockReturnValue(CFG);
		(AcpTaskStore as any).mockImplementation(function () { return ts; });
		(MailboxManager as any).mockImplementation(function () { return mb; });
		(GovernanceStore as any).mockImplementation(function () { return gs; });
		(AcpEventLog as any).mockImplementation(function () { return el; });
		(createAdapter as any).mockImplementation(() => fakeAdapter);
		(AgentCoordinator as any).mockImplementation(function () { return { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn() }; });

		// main() builds its own REAL SessionManager internally. Capture each
		// handle the moment it is added, so we can assert on it after teardown.
		const origAdd = SessionManager.prototype.add;
		vi.spyOn(SessionManager.prototype, "add").mockImplementation(function (this: any, handle: AcpSessionHandle) {
			capturedHandle = handle;
			return origAdd.call(this, handle);
		});

		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
	});

	it("tears down a one-shot (idleTtlMs:0) session after successful completion", async () => {
		const result = await tools.get("acp_spawn").execute(
			"t",
			{ agent: "gemini", prompt: "hi", idleTtlMs: 0 },
			undefined,
			undefined,
			ctx,
		);

		// Sanity: the prompt ran and returned the ephemeral session id.
		expect(result.details.sessionId).toBe("ses-ephemeral");
		expect(capturedHandle).toBeDefined();
		expect(capturedHandle!.sessionId).toBe("ses-ephemeral");

		// sessionMgr.size === 0 — acp_status surfaces this in details.sessionCount.
		const status = await tools.get("acp_status").execute("t", {}, undefined, undefined, ctx);
		expect(status.details.sessionCount).toBe(0);

		// The handle is gone from the LIVE registry: the full status output
		// lists zero active sessions (the closed handle is archived, not live).
		expect(status.content[0].text).toContain("Active Sessions (0)");

		// handle.disposed === true
		expect(capturedHandle!.disposed).toBe(true);

		// And the adapter was actually disposed (no live subprocess leak).
		expect(fakeAdapter.dispose).toHaveBeenCalled();
	});

	it("tears down the session handle when adapter.prompt throws (T2)", async () => {
		// Make the fake adapter's prompt reject AFTER the session handle was
		// created (new-session path).
		fakeAdapter.prompt.mockRejectedValueOnce(new Error("boom"));

		// Invoke acp_spawn (one-shot) via the prompt path. The tool's safeExecute
		// wrapper catches the error and returns an error result rather than
		// rejecting.
		const result = await tools.get("acp_spawn").execute(
			"t",
			{ agent: "gemini", prompt: "hi", idleTtlMs: 0 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.error).toBeTruthy();

		// Sanity: a handle was created before prompt threw.
		expect(capturedHandle).toBeDefined();

		// sessionMgr.size === 0 — the leaked registry entry must be gone.
		const status = await tools.get("acp_status").execute("t", {}, undefined, undefined, ctx);
		expect(status.details.sessionCount).toBe(0);
		expect(status.content[0].text).toContain("Active Sessions (0)");

		// handle.disposed === true — the handle was disposed, not just the
		// raw adapter.
		expect(capturedHandle!.disposed).toBe(true);
	});
});

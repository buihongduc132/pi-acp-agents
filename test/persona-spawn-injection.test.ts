/**
 * Tests for persona injection at the acp_spawn path in index.ts.
 *
 * Verifies: inline persona is prepended to the first prompt; missing-file
 * persona soft-fails with a warning in the result (no throw); gist value
 * soft-fails with deferred warning (no network call).
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
	SessionArchiveStore: class {
		get = vi.fn(); upsert = vi.fn();
	},
}));
vi.mock("../src/management/session-name-store.js", () => ({
	SessionNameStore: class {
		getSessionId = vi.fn(); getName = vi.fn(); register = vi.fn();
	},
}));
vi.mock("../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime", tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json", governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl", sessionArchiveFile: "/mock/runtime/session-archive.json",
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json", dagDir: "/mock/runtime/dag", dagIndexFile: "/mock/runtime/dag/dag-index.json",
	}),
}));
vi.mock("../src/logger.js", () => ({ createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", () => ({ AgentCoordinator: vi.fn() }));
vi.mock("../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: vi.fn() }) }));
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

// Capture the prompt arg passed to adapter.prompt so we can assert persona injection.
let capturedPrompt: string | null = null;
let tools = new Map<string, any>();
let ctx: any;

function setupWithConfig(cfg: any) {
	capturedPrompt = null;
	tools = new Map<string, any>();
	(loadConfig as any).mockReturnValue(cfg);
	(SessionManager as any).mockImplementation(function () { return { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0 }; });
	(AcpTaskStore as any).mockImplementation(function () { return { create: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })), updateWhere: vi.fn(() => []) }; });
	(MailboxManager as any).mockImplementation(function () { return { send: vi.fn(), listFor: vi.fn(() => []), clearFor: vi.fn(() => 0), listAll: vi.fn(() => []) }; });
	(GovernanceStore as any).mockImplementation(function () { return { getPlan: vi.fn(), requestPlan: vi.fn(), resolvePlan: vi.fn(), getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) }; });
	(AcpEventLog as any).mockImplementation(function () { return { append: vi.fn() }; });
	(AcpCircuitBreaker as any).mockImplementation(function () { return { execute: vi.fn(async (fn: () => any) => fn()), state: "closed", isHealthy: vi.fn(() => true), recordSuccess: vi.fn(), recordFailure: vi.fn() }; });
	(HealthMonitor as any).mockImplementation(function () { return { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() }; });
	(createAdapter as any).mockImplementation(function () {
		return {
			spawn: vi.fn(), initialize: vi.fn(),
			newSession: vi.fn(async () => "ses_mock"), loadSession: vi.fn(),
			prompt: vi.fn(async (msg: string) => { capturedPrompt = msg; return { text: "ok", stopReason: "end_turn", sessionId: "ses_mock" }; }),
			setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
		};
	});
	(AgentCoordinator as any).mockImplementation(function () { return { delegate: vi.fn(), broadcast: vi.fn(), compare: vi.fn() }; });
	ctx = {};
	main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn() } as any);
}

const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);

const BASE_CFG = {
	defaultAgent: "gemini", staleTimeoutMs: 3_600_000, circuitBreakerMaxFailures: 3, circuitBreakerResetMs: 60_000, stallTimeoutMs: 300_000, modelPolicy: {},
};

describe("acp_spawn persona injection", () => {
	beforeEach(() => setupWithConfig({ ...BASE_CFG, agent_servers: { gemini: { command: "gemini", args: ["--acp"] } } }));

	it("prepends inline persona to the first prompt", async () => {
		setupWithConfig({ ...BASE_CFG, agent_servers: { gemini: { command: "gemini", args: ["--acp"], systemPrompt: "You are a strict reviewer." } } });
		await exec("acp_spawn", { agent: "gemini", prompt: "review this code" });
		expect(capturedPrompt).toContain("You are a strict reviewer.");
		expect(capturedPrompt).toContain("review this code");
		expect(capturedPrompt).toContain("---");
	});

	it("soft-fails with warnings when persona file is missing (no throw)", async () => {
		setupWithConfig({ ...BASE_CFG, agent_servers: { gemini: { command: "gemini", args: ["--acp"], systemPrompt: "/nonexistent/persona.md" } } });
		const r = await exec("acp_spawn", { agent: "gemini", prompt: "hi" });
		expect(capturedPrompt).toBe("hi");
		expect(r.details.warnings).toBeDefined();
		expect(r.details.warnings.join("\n")).toMatch(/not found|missing|file/i);
	});

	it("soft-fails with deferred warning for gist URL (no network call)", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({}) } as any);
		setupWithConfig({ ...BASE_CFG, agent_servers: { gemini: { command: "gemini", args: ["--acp"], systemPrompt: "https://gist.github.com/user/abc123" } } });
		const r = await exec("acp_spawn", { agent: "gemini", prompt: "hi" });
		expect(capturedPrompt).toBe("hi");
		expect(r.details.warnings.join("\n")).toMatch(/deferred/i);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});

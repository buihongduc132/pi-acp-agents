import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/config.js", () => ({
	loadConfig: () => ({
		agent_servers: { gemini: { command: "gemini", args: ["--acp"] } },
		defaultAgent: "gemini",
		staleTimeoutMs: 3_600_000,
		circuitBreakerMaxFailures: 3,
		circuitBreakerResetMs: 60_000,
		stallTimeoutMs: 300_000,
		modelPolicy: {},
	}),
}));
vi.mock("../src/core/session-manager.js", () => ({
	SessionManager: class {
		size = 0;
		list() { return []; }
		listByAgent() { return []; }
		get() { return undefined; }
		add() {}
		remove() { return Promise.resolve(); }
		disposeAll() { return Promise.resolve(); }
		pruneStale() { return Promise.resolve({ removedSessionIds: [] }); }
	},
}));
vi.mock("../src/management/task-store.js", () => ({
	AcpTaskStore: class {
		list() { return []; }
		clear() { return { removed: 0, remaining: 0 }; }
	},
}));
vi.mock("../src/management/mailbox-manager.js", () => ({
	MailboxManager: class {
		clearFor() { return 0; }
	},
}));
vi.mock("../src/management/governance-store.js", () => ({
	GovernanceStore: class {
		setModelPolicy() {}
	},
}));
vi.mock("../src/management/event-log.js", () => ({
	AcpEventLog: class {
		append() {}
	},
}));
vi.mock("../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class {
		get() { return undefined; }
		upsert(v: unknown) { return v; }
	},
}));
vi.mock("../src/management/session-name-store.js", () => ({
	SessionNameStore: class {
		getSessionId() { return undefined; }
		getName() { return undefined; }
		register() { return undefined; }
	},
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
	}),
}));
vi.mock("../src/logger.js", () => ({ createFileLogger: () => ({ info() {}, error() {}, debug() {} }) }));
vi.mock("../src/core/circuit-breaker.js", () => ({
	AcpCircuitBreaker: class {
		state = "closed";
		execute<T>(fn: () => Promise<T>) { return fn(); }
	},
}));
vi.mock("../src/core/health-monitor.js", () => ({
	HealthMonitor: class {
		start() {}
		stop() {}
		register() {}
	},
}));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: () => ({ dispose() {} }) }));
vi.mock("../src/coordination/coordinator.js", () => ({ AgentCoordinator: class {} }));
vi.mock("../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: vi.fn() }) }));

import main from "../index.js";

describe("ACP command surface", () => {
	let commands = new Map<string, any>();
	let notifications: string[] = [];
	const ctx = {
		cwd: "/project",
		ui: {
			setWidget: vi.fn(),
			notify: vi.fn((message: string) => {
				notifications.push(message);
			}),
		},
	};

	beforeEach(() => {
		commands = new Map();
		notifications = [];
		vi.clearAllMocks();
		main({
			registerTool: vi.fn(),
			registerCommand: vi.fn((name: string, opts: any) => commands.set(name, opts)),
			on: vi.fn(),
			getCommands: vi.fn(() => Array.from(commands.entries()).map(([name, opts]) => ({ name, source: "extension", description: opts.description }))),
		} as any);
	});

	it("registers /acp root command with ACP-applicable groups", () => {
		expect(commands.has("acp")).toBe(true);
		expect(commands.has("acp-doctor")).toBe(true);
		expect(commands.has("acp-config")).toBe(true);
		expect(commands.get("acp")?.description).toContain("session");
		expect(commands.get("acp")?.description).toContain("runtime");
	});

	it("lists root command and compatibility aliases for command discoverability", async () => {
		await commands.get("acp").handler("", ctx as any);
		const joined = notifications.join("\n");
		expect(joined).toContain("/acp");
		expect(joined).toContain("/acp-doctor");
		expect(joined).toContain("/acp-config");
	});

	it.each([
		["session new", "session", "new"],
		["prompt", "prompt", undefined],
		["delegate", "delegate", undefined],
		["broadcast", "broadcast", undefined],
		["compare", "compare", undefined],
		["task create", "task", "create"],
		["message send", "message", "send"],
		["plan request", "plan", "request"],
		["runtime status", "runtime", "status"],
	])("parses /acp %s", async (input, group, subcommand) => {
		await commands.get("acp").handler(input, ctx as any);
		const joined = notifications.join("\n");
		expect(joined).toContain(`Group: ${group}`);
		if (subcommand) expect(joined).toContain(`Subcommand: ${subcommand}`);
	});

	it("keeps /acp-doctor alias routed to runtime doctor", async () => {
		await commands.get("acp-doctor").handler("", ctx as any);
		expect(notifications[0]).toContain('"runtimeDir": "/mock/runtime"');
	});

	it("keeps /acp-config alias routed to runtime config", async () => {
		await commands.get("acp-config").handler("", ctx as any);
		const joined = notifications.join("\n");
		expect(joined).toContain("ACP Agent Servers Config");
		expect(joined).toContain("Default: gemini");
	});
});

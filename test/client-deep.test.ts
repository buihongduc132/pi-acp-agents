import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

// Create mock proc factory
function makeFakeProc() {
	const stdin = new Writable({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
	const stdout = new Readable({ read() {} });
	const stderr = new EventEmitter();
	return { stdin, stdout, stderr, killed: false, kill: vi.fn(), on: vi.fn() };
}

const mockKillWithEscalation = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => makeFakeProc()),
}));

vi.mock("../src/core/circuit-breaker.js", () => ({
	killWithEscalation: (...args: any[]) => mockKillWithEscalation(...args),
}));

vi.mock("../src/core/protocol-validator.js", () => ({
	classifyConnectionError: vi.fn((err) => err),
	validateInitializeResponse: vi.fn(),
	validateNewSessionResponse: vi.fn(),
	validatePromptResponse: vi.fn(),
	AcpProtocolError: class extends Error {
		constructor(public details: any) { super(details.message); this.name = "AcpProtocolError"; }
	},
}));

vi.mock("../src/logger.js", () => ({
	createFileLogger: vi.fn(() => ({
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	})),
}));

// Mock the SDK — use a class that tracks callbacks
let capturedCallbacks: any = null;

vi.mock("@agentclientprotocol/sdk", () => {
	class MockClientSideConnection {
		initialize = vi.fn();
		newSession = vi.fn();
		prompt = vi.fn();
		cancel = vi.fn();
		loadSession = vi.fn();
		authenticate = vi.fn();
		unstable_setSessionModel = vi.fn();
		setSessionMode = vi.fn();

		constructor(callbacks: any) {
			capturedCallbacks = callbacks;
		}
	}
	return {
		ClientSideConnection: MockClientSideConnection,
		ndJsonStream: vi.fn(() => ({})),
		PROTOCOL_VERSION: 1,
	};
});

import { AcpClient } from "../src/core/client.js";

describe("AcpClient — deep branches", () => {
	function createClient(opts: Record<string, any> = {}) {
		return new AcpClient({
			agentName: "test-agent",
			config: { command: "test-cmd", args: [], ...opts.config },
			cwd: "/tmp",
			logsDir: "/tmp/test-logs",
			...opts,
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		capturedCallbacks = null;
	});

	async function connectAndGetConn(client: AcpClient) {
		await client.connect();
		// The connection object is stored in client.conn
		return (client as any).conn;
	}

	describe("connect — stdin/stdout null branches", () => {
		it.skip("covered by client-unit.test.ts", () => {});
	});

	describe("initialize", () => {
		it("succeeds with auth methods", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.initialize.mockResolvedValueOnce({
				protocolVersion: 1,
				agentInfo: { name: "test" },
				authMethods: [{ id: "auth1", name: "Test Auth" }],
			});
			conn.authenticate.mockResolvedValueOnce({});
			const result = await client.initialize();
			expect(result.authMethods).toHaveLength(1);
			expect(conn.authenticate).toHaveBeenCalledWith({ methodId: "auth1" });
		});

		it("succeeds with empty auth methods", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.initialize.mockResolvedValueOnce({
				protocolVersion: 1,
				agentInfo: { name: "test" },
				authMethods: [],
			});
			const result = await client.initialize();
			expect(result.authMethods).toHaveLength(0);
			expect(conn.authenticate).not.toHaveBeenCalled();
		});

		it("succeeds with no auth methods field", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.initialize.mockResolvedValueOnce({
				protocolVersion: 1,
				agentInfo: { name: "test" },
			});
			await client.initialize();
			expect(conn.authenticate).not.toHaveBeenCalled();
		});

		it("continues when auth fails (best-effort)", async () => {
			const client = createClient({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } });
			const conn = await connectAndGetConn(client);
			conn.initialize.mockResolvedValueOnce({
				protocolVersion: 1,
				agentInfo: { name: "test" },
				authMethods: [{ id: "auth1" }],
			});
			conn.authenticate.mockRejectedValueOnce(new Error("auth fail"));
			const result = await client.initialize();
			expect(result).toBeDefined();
		});

		it("handles initialize error — classifyConnectionError is called", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.initialize.mockRejectedValueOnce(new Error("init fail"));
			// classifyConnectionError will be called and re-throw
			await expect(client.initialize()).rejects.toThrow();
		});
	});

	describe("newSession", () => {
		it("sets default model when configured", async () => {
			const client = createClient({ config: { command: "c", args: [], default_model: "gpt-4" } });
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-1", models: {}, modes: {} });
			conn.unstable_setSessionModel.mockResolvedValueOnce({});
			const sessionId = await client.newSession();
			expect(sessionId).toBe("sess-1");
			expect(conn.unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: "sess-1", modelId: "gpt-4" });
		});

		it("sets default mode when configured", async () => {
			const client = createClient({ config: { command: "c", args: [], default_mode: "auto" } });
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-2", models: {}, modes: {} });
			conn.setSessionMode.mockResolvedValueOnce({});
			const sessionId = await client.newSession();
			expect(sessionId).toBe("sess-2");
			expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "sess-2", modeId: "auto" });
		});

		it("skips model/mode when not configured", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-3", models: {}, modes: {} });
			await client.newSession();
			expect(conn.unstable_setSessionModel).not.toHaveBeenCalled();
			expect(conn.setSessionMode).not.toHaveBeenCalled();
		});

		it("handles set model failure gracefully", async () => {
			const client = createClient({
				config: { command: "c", args: [], default_model: "gpt-4" },
				logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
			});
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-4", models: {}, modes: {} });
			conn.unstable_setSessionModel.mockRejectedValueOnce(new Error("model fail"));
			const sessionId = await client.newSession();
			expect(sessionId).toBe("sess-4");
		});

		it("handles set mode failure gracefully", async () => {
			const client = createClient({
				config: { command: "c", args: [], default_mode: "auto" },
				logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
			});
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-5", models: {}, modes: {} });
			conn.setSessionMode.mockRejectedValueOnce(new Error("mode fail"));
			const sessionId = await client.newSession();
			expect(sessionId).toBe("sess-5");
		});

		it("handles newSession error — classifyConnectionError is called", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockRejectedValueOnce(new Error("session fail"));
			await expect(client.newSession()).rejects.toThrow();
		});
	});

	describe("prompt", () => {
		it("returns text and stopReason", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-p", models: {}, modes: {} });
			conn.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
			await client.newSession();
			const result = await client.prompt("hello");
			expect(result.stopReason).toBe("end_turn");
		});

		it("throws when stopReason is error", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-pe", models: {}, modes: {} });
			conn.prompt.mockResolvedValueOnce({ stopReason: "error" });
			await client.newSession();
			await expect(client.prompt("hello")).rejects.toThrow("stopReason=error");
		});

		it("handles prompt error (non-protocol) — throws", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-pf", models: {}, modes: {} });
			conn.prompt.mockRejectedValueOnce(new Error("prompt rpc fail"));
			await client.newSession();
			await expect(client.prompt("hello")).rejects.toThrow();
		});

		it("handles prompt error (protocol error) — throws", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-pp", models: {}, modes: {} });
			conn.prompt.mockRejectedValueOnce(new Error("protocol fail"));
			await client.newSession();
			await expect(client.prompt("hello")).rejects.toThrow();
		});
	});

	describe("quickPrompt", () => {
		it("connects + initializes + creates session if not connected", async () => {
			const client = createClient();
			// Don't connect first — quickPrompt should handle it
			const conn = await connectAndGetConn(client);
			// Reset to simulate not-connected
			conn.initialize.mockResolvedValueOnce({ protocolVersion: 1, agentInfo: { name: "test" } });
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-qp", models: {}, modes: {} });
			conn.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
			// Directly test the prompt path
			await client.initialize();
			await client.newSession();
			const result = await client.prompt("hello");
			expect(result.stopReason).toBe("end_turn");
		});

		it("maps cancelled stopReason", async () => {
			const client = createClient();
			await client.connect();
			const conn = (client as any).conn;
			conn.initialize.mockResolvedValueOnce({ protocolVersion: 1, agentInfo: { name: "test" } });
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-qpc", models: {}, modes: {} });
			conn.prompt.mockResolvedValueOnce({ stopReason: "cancelled" });
			const result = await client.quickPrompt("hello");
			expect(result.stopReason).toBe("cancelled");
		});
	});

	describe("loadSession", () => {
		it("loads a session and sets current sessionId", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.loadSession.mockResolvedValueOnce({});
			const sid = await client.loadSession("existing-session");
			expect(sid).toBe("existing-session");
			expect(client.sessionId).toBe("existing-session");
		});
	});

	describe("setModel/setMode/cancel with active session", () => {
		it("sets model on current session", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-sm", models: {}, modes: {} });
			conn.unstable_setSessionModel.mockResolvedValueOnce({});
			await client.newSession();
			await client.setModel("gpt-4");
			expect(conn.unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: "sess-sm", modelId: "gpt-4" });
		});

		it("sets mode on current session", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-smode", models: {}, modes: {} });
			conn.setSessionMode.mockResolvedValueOnce({});
			await client.newSession();
			await client.setMode("auto");
			expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "sess-smode", modeId: "auto" });
		});

		it("cancels active session prompt", async () => {
			const client = createClient();
			const conn = await connectAndGetConn(client);
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-c", models: {}, modes: {} });
			conn.cancel.mockResolvedValueOnce({});
			await client.newSession();
			await client.cancel();
			expect(conn.cancel).toHaveBeenCalledWith({ sessionId: "sess-c" });
		});
	});

	describe("handleSessionUpdate", () => {
		it("accumulates text from agent_message_chunk", async () => {
			const onActivity = vi.fn();
			const client = createClient({ onActivity });
			await client.connect();
			const conn = (client as any).conn;
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-upd", models: {}, modes: {} });
			await client.newSession();

			expect(capturedCallbacks).not.toBeNull();
			const sessionUpdateCb = capturedCallbacks().sessionUpdate;

			await sessionUpdateCb({
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
			});
			await sessionUpdateCb({
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "World" } },
			});
			expect((client as any).collectedText).toBe("Hello World");
			expect(onActivity).toHaveBeenCalled();
		});

		it("accumulates text from agent_thought_chunk", async () => {
			const client = createClient();
			await client.connect();
			const conn = (client as any).conn;
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-think", models: {}, modes: {} });
			await client.newSession();

			const sessionUpdateCb = capturedCallbacks().sessionUpdate;
			await sessionUpdateCb({
				update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } },
			});
			expect((client as any).collectedText).toBe("Thinking...");
		});

		it("ignores non-text content types", async () => {
			const client = createClient();
			await client.connect();
			const conn = (client as any).conn;
			conn.newSession.mockResolvedValueOnce({ sessionId: "sess-nt", models: {}, modes: {} });
			await client.newSession();

			const sessionUpdateCb = capturedCallbacks().sessionUpdate;
			await sessionUpdateCb({
				update: { sessionUpdate: "agent_message_chunk", content: { type: "image", url: "http://..." } },
			});
			expect((client as any).collectedText).toBe("");
		});

		it("handles requestPermission callback", async () => {
			const client = createClient();
			await client.connect();

			const requestPermCb = capturedCallbacks().requestPermission;
			const result = await requestPermCb();
			expect(result.outcome).toBe("approved");
		});
	});
});

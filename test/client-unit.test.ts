import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

// Mock child_process spawn
const mockSpawn = vi.fn();
const mockKillFn = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args: any[]) => mockSpawn(...args),
}));

// Mock circuit-breaker
const mockKillWithEscalation = vi.fn();
vi.mock("../src/core/circuit-breaker.js", () => ({
	killWithEscalation: (...args: any[]) => mockKillWithEscalation(...args),
}));

// Mock protocol-validator
vi.mock("../src/core/protocol-validator.js", () => ({
	classifyConnectionError: vi.fn((err) => err),
	validateInitializeResponse: vi.fn(),
	validateNewSessionResponse: vi.fn(),
	validatePromptResponse: vi.fn(),
	AcpProtocolError: class extends Error {
		constructor(public details: any) {
			super(details.message);
			this.name = "AcpProtocolError";
		}
	},
}));

// Mock logger
vi.mock("../src/logger.js", () => ({
	createFileLogger: vi.fn(() => ({
		info: vi.fn(),
    warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	})),
}));

import { AcpClient } from "../src/core/client.js";

function makeFakeProc() {
	const stdin = new Writable({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
	const stdout = new Readable({ read() {} });
	const stderr = new EventEmitter();

	const proc = {
		stdin,
		stdout,
		stderr,
		killed: false,
		kill: mockKillFn,
		on: vi.fn(),
	};
	return proc;
}

describe("AcpClient", () => {
	function createClient(opts: Record<string, any> = {}) {
		return new AcpClient({
			agentName: "test-agent",
			config: { command: "test-cmd", args: [] },
			cwd: "/tmp",
			...opts,
		});
	}

	beforeEach(() => {
		mockSpawn.mockReturnValue(makeFakeProc());
	});

	describe("constructor", () => {
		it("uses provided agentName", () => {
			const client = createClient({ agentName: "my-agent" });
			expect(client["agentName"]).toBe("my-agent");
		});

		it("defaults cwd to process.cwd()", () => {
			const client = new AcpClient({
				agentName: "test",
				config: { command: "c", args: [] },
			});
			expect(client["cwd"]).toBe(process.cwd());
		});

		it("defaults clientInfo", () => {
			const client = createClient();
			expect(client["clientInfo"].name).toBe("pi-acp-agents");
		});
	});

	describe("properties", () => {
		it("sessionId starts null", () => {
			const client = createClient();
			expect(client.sessionId).toBeNull();
		});

		it("agentInfo starts null", () => {
			const client = createClient();
			expect(client.agentInfo).toBeNull();
		});

		it("connected is false when no connection", () => {
			const client = createClient();
			expect(client.connected).toBe(false);
		});
	});

	describe("connect", () => {
		it("spawns the agent process", async () => {
			const client = createClient();
			await client.connect();
			expect(mockSpawn).toHaveBeenCalledWith(
				"test-cmd",
				[],
				expect.objectContaining({
					stdio: ["pipe", "pipe", "pipe"],
				}),
			);
		});

		it("passes env from config", async () => {
			const client = createClient({
				config: { command: "c", args: [], env: { MY_VAR: "val" } },
			});
			await client.connect();
			expect(mockSpawn).toHaveBeenCalledWith(
				"c",
				[],
				expect.objectContaining({
					env: expect.objectContaining({ MY_VAR: "val" }),
				}),
			);
		});

		it("sets connected to true after spawn", async () => {
			const client = createClient();
			await client.connect();
			expect(client.connected).toBe(true);
		});

		it("throws when spawn throws", async () => {
			mockSpawn.mockImplementationOnce(() => {
				throw new Error("spawn failed");
			});
			const client = createClient();
			await expect(client.connect()).rejects.toThrow("spawn failed");
		});
	});

	describe("initialize", () => {
		it("throws when not connected", async () => {
			const client = createClient();
			await expect(client.initialize()).rejects.toThrow("Not connected");
		});
	});

	describe("newSession", () => {
		it("throws when not connected", async () => {
			const client = createClient();
			await expect(client.newSession()).rejects.toThrow("Not connected");
		});
	});

	describe("prompt", () => {
		it("throws when no active session", async () => {
			const client = createClient();
			await expect(client.prompt("hello")).rejects.toThrow("No active session");
		});
	});

	describe("cancel", () => {
		it("does nothing when not connected", async () => {
			const client = createClient();
			await expect(client.cancel()).resolves.toBeUndefined();
		});
	});

	describe("loadSession", () => {
		it("throws when not connected", async () => {
			const client = createClient();
			await expect(client.loadSession("sid")).rejects.toThrow("Not connected");
		});
	});

	describe("setModel", () => {
		it("throws when no active session", async () => {
			const client = createClient();
			await expect(client.setModel("gpt-4")).rejects.toThrow("No active session");
		});
	});

	describe("setMode", () => {
		it("throws when no active session", async () => {
			const client = createClient();
			await expect(client.setMode("auto")).rejects.toThrow("No active session");
		});
	});

	describe("dispose", () => {
		it("kills process and clears state", async () => {
			const client = createClient();
			await client.connect();
			expect(client.connected).toBe(true);
			await client.dispose();
			expect(client.connected).toBe(false);
			expect(client.sessionId).toBeNull();
		});

		it("calls killWithEscalation on active process", async () => {
			const client = createClient();
			await client.connect();
			await client.dispose();
			expect(mockKillWithEscalation).toHaveBeenCalled();
		});

		it("is safe to call multiple times", async () => {
			const client = createClient();
			await client.dispose();
			await client.dispose();
		});
	});
});

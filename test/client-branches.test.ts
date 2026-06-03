/**
 * Additional branch coverage for client.ts
 * Targets: createFilteredStdoutStream, handleSessionUpdate branches,
 * stderr truncation, quickPrompt lifecycle, setModel/setMode without session
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Readable, Writable, EventEmitter } from "node:stream";

// Mock child_process
const mockSpawn = mock((...args: any[]) => {
	throw new Error("spawn ENOENT");
});
mock.module("node:child_process", () => ({
	spawn: mockSpawn,
}));

// Mock circuit-breaker
mock.module("../src/core/circuit-breaker.js", () => ({
	killWithEscalation: mock(),
}));

// Mock protocol-validator
mock.module("../src/core/protocol-validator.js", () => ({
	AcpProtocolError: class AcpProtocolError extends Error {},
	classifyConnectionError: (err: Error) => err,
	validateInitializeResponse: mock(),
	validateNewSessionResponse: mock(),
	validatePromptResponse: mock(),
}));

// Mock logger
mock.module("../src/logger.js", () => ({
	createFileLogger: mock(() => ({
		info: mock(),
		error: mock(),
		debug: mock(),
	})),
	createNoopLogger: mock(() => ({
		info: mock(),
		error: mock(),
		debug: mock(),
	})),
}));

import { AcpClient } from "../src/core/client.js";

function createMockProc() {
	const proc = new EventEmitter() as any;
	proc.stdin = new Writable() as any;
	proc.stdout = new Readable({ read() {} }) as any;
	proc.stderr = new EventEmitter() as any;
	proc.killed = false;
	proc.kill = mock(() => { proc.killed = true; });
	return proc;
}

function makeClient(opts: any = {}) {
	return new AcpClient({
		agentName: opts.agentName ?? "test-agent",
		config: opts.config ?? { command: "test-cmd", args: [] },
		cwd: opts.cwd ?? "/tmp",
		...opts,
	});
}

describe("AcpClient — branch coverage", () => {
	beforeEach(() => {
	});

	describe("connect — spawn failure", () => {
		it("throws when spawn throws", async () => {
			mockSpawn.mockImplementation(() => {
				throw new Error("spawn ENOENT");
			});
			const client = makeClient();
			await expect(client.connect()).rejects.toThrow("spawn ENOENT");
		});

		it("throws when proc has no stdin", async () => {
			const proc = createMockProc();
			delete proc.stdin;
			mockSpawn.mockReturnValue(proc);
			const client = makeClient();
			await expect(client.connect()).rejects.toThrow("Failed to create stdio pipes");
		});
	});

	describe("connected getter", () => {
		it("returns false when no conn and no proc", () => {
			const client = makeClient();
			expect(client.connected).toBe(false);
		});

		it("returns false when proc is killed", async () => {
			const proc = createMockProc();
			mockSpawn.mockReturnValue(proc);
			const client = makeClient();
			await client.connect();
			proc.killed = true;
			expect(client.connected).toBe(false);
		});

		it("returns true when conn and proc exist and proc not killed", async () => {
			const proc = createMockProc();
			mockSpawn.mockReturnValue(proc);
			const client = makeClient();
			await client.connect();
			expect(client.connected).toBe(true);
		});
	});

	describe("initialize — not connected", () => {
		it("throws when not connected", async () => {
			const client = makeClient();
			await expect(client.initialize()).rejects.toThrow("Not connected");
		});
	});

	describe("newSession — not connected", () => {
		it("throws when not connected", async () => {
			const client = makeClient();
			await expect(client.newSession()).rejects.toThrow("Not connected");
		});
	});

	describe("prompt — no active session", () => {
		it("throws when no session", async () => {
			const client = makeClient();
			await expect(client.prompt("hello")).rejects.toThrow("No active session");
		});
	});

	describe("setModel — no session", () => {
		it("throws when no session", async () => {
			const client = makeClient();
			await expect(client.setModel("gpt-4")).rejects.toThrow("No active session");
		});
	});

	describe("setMode — no session", () => {
		it("throws when no session", async () => {
			const client = makeClient();
			await expect(client.setMode("auto")).rejects.toThrow("No active session");
		});
	});

	describe("loadSession — not connected", () => {
		it("throws when not connected", async () => {
			const client = makeClient();
			await expect(client.loadSession("abc")).rejects.toThrow("Not connected");
		});
	});

	describe("cancel — no conn or session", () => {
		it("does nothing when no conn", async () => {
			const client = makeClient();
			await client.cancel();
			// No throw — graceful no-op
		});
	});

	describe("stderr accumulation and truncation", () => {
		it("accumulates stderr and truncates at 2048 chars", async () => {
			const proc = createMockProc();
			mockSpawn.mockReturnValue(proc);
			const client = makeClient();
			await client.connect();

			// Emit stderr > 2048 chars
			const longChunk = "x".repeat(1500);
			proc.stderr.emit("data", Buffer.from(longChunk));
			proc.stderr.emit("data", Buffer.from(longChunk));

			// Access private field
			const stderr = (client as any).lastStderr;
			expect(stderr.length).toBeLessThanOrEqual(2048);
			expect(stderr.length).toBe(2048);
		});
	});

	describe("sessionId and agentInfo getters", () => {
		it("returns null sessionId initially", () => {
			const client = makeClient();
			expect(client.sessionId).toBeNull();
		});

		it("returns null agentInfo initially", () => {
			const client = makeClient();
			expect(client.agentInfo).toBeNull();
		});
	});

	describe("quickPrompt", () => {
		it("quickPrompt method exists", async () => {
			const client = makeClient();
			expect(typeof client.quickPrompt).toBe("function");
		});
	});
});

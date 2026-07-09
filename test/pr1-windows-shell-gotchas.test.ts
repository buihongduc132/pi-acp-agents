/**
 * RED tests — PR #1 gotchas: "fix: gemini ACP ENOENT on Windows (resolve .cmd via shell)"
 *
 * PR #1 adds `shell: platform() === "win32"` to spawn() in src/core/client.ts.
 * These tests prove gotchas that the PR missed or introduced.
 *
 * Gotchas:
 *   G1: AcpxAdapter._runAcpx() uses spawnSync WITHOUT shell:true — same ENOENT bug class
 *   G2: shell:true orphans child processes — killWithEscalation kills cmd.exe, not the agent
 *   G3: No existing test verifies the shell option is passed to spawn()
 *
 * All tests here are RED — they MUST fail until the gotchas are fixed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable, Writable, EventEmitter } from "node:stream";

// ---------------------------------------------------------------------------
// Shared mock state — hoisted for vi.mock factory access
// ---------------------------------------------------------------------------
const { spawnSyncMock, mockSpawn, mockPlatform } = vi.hoisted(() => ({
	spawnSyncMock: vi.fn(() => ({
		status: 0,
		stdout: JSON.stringify({ sessionId: "test-sess" }),
		stderr: "",
	})),
	mockSpawn: vi.fn(),
	mockPlatform: vi.fn(() => "linux"),
}));

// ---------------------------------------------------------------------------
// Mock node:os so platform() returns what we control
// This is critical because client.ts does: import { platform } from "node:os"
// ---------------------------------------------------------------------------
vi.mock("node:os", () => ({
	platform: mockPlatform,
}));

vi.mock("node:child_process", () => ({
	spawnSync: spawnSyncMock,
	spawn: mockSpawn,
}));

vi.mock("../src/core/circuit-breaker.js", () => ({
	killWithEscalation: vi.fn((proc: any) => {
		proc.kill("SIGTERM");
	}),
}));

vi.mock("../src/core/protocol-validator.js", () => ({
	AcpProtocolError: class extends Error {
		constructor(opts: any) { super(typeof opts === "string" ? opts : opts?.message || String(opts)); }
	},
	classifyConnectionError: vi.fn((err) => err),
	validateInitializeResponse: vi.fn(),
	validateNewSessionResponse: vi.fn(),
	validatePromptResponse: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
	createFileLogger: vi.fn(() => ({
		info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
	})),
	createNoopLogger: vi.fn(() => ({
		info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
	})),
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks — mockPlatform controls platform())
// ---------------------------------------------------------------------------
import { AcpxAdapter } from "../src/adapters/acpx.js";
import { AcpClient } from "../src/core/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeFakeProc() {
	const proc = new EventEmitter() as any;
	proc.stdin = new Writable({ write(_c: any, _e: any, cb: any) { cb(); } });
	proc.stdout = new Readable({ read() {} });
	proc.stderr = new EventEmitter();
	proc.killed = false;
	proc.kill = vi.fn(() => { proc.killed = true; });
	proc.pid = 12345;
	return proc;
}

// ===========================================================================
// G1: AcpxAdapter._runAcpx() does NOT pass shell:true on Windows
//
// The PR only fixed AcpClient.spawn() but AcpxAdapter._runAcpx() uses
// spawnSync with the same command (acpx binary which could be a .cmd shim).
// Same ENOENT bug class exists on Windows.
// ===========================================================================
describe("G1: AcpxAdapter spawnSync missing shell:true on Windows", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ sessionId: "test-sess" }),
			stderr: "",
		});
		mockPlatform.mockReturnValue("win32");
	});

	it("RED: passes shell:true on Windows to resolve .cmd shims", async () => {
		const adapter = new AcpxAdapter({
			config: { command: "acpx" },
			agentName: "gemini",
		});
		await adapter.spawn();

		// The spawnSync call MUST include shell:true on win32
		const calls = spawnSyncMock.mock.calls as unknown as [string, string[], Record<string, unknown>?, ...unknown[]][];
		const options = calls[0]?.[2];

		// RED: This will FAIL because AcpxAdapter does NOT pass shell:true
		expect(options).toBeDefined();
		expect(options!.shell).toBe(true);
	});

	it("GREEN: does NOT pass shell:true on non-Windows", async () => {
		mockPlatform.mockReturnValue("darwin");

		const adapter = new AcpxAdapter({
			config: { command: "acpx" },
			agentName: "gemini",
		});
		await adapter.spawn();

		const calls = spawnSyncMock.mock.calls as unknown as [string, string[], Record<string, unknown>?, ...unknown[]][];
		const options = calls[0]?.[2];

		// On non-Windows, shell should be false or undefined (not true)
		expect(options?.shell).toBeFalsy();
	});
});

// ===========================================================================
// G3: spawn() in AcpClient receives correct shell option per platform
//
// The PR adds `shell: platform() === "win32"` — these tests verify it works.
// ===========================================================================
describe("G3: AcpClient spawn() receives correct shell option per platform", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockSpawn.mockReturnValue(makeFakeProc());
	});

	it("RED→GREEN: passes shell:true on win32 platform", async () => {
		mockPlatform.mockReturnValue("win32");

		const client = new AcpClient({
			agentName: "gemini",
			config: { command: "gemini", args: [] },
			cwd: "/tmp",
		});
		await client.connect();

		const spawnOpts = mockSpawn.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(spawnOpts).toBeDefined();
		expect(spawnOpts.shell).toBe(true);
	});

	it("RED→GREEN: passes shell:false on darwin (macOS)", async () => {
		mockPlatform.mockReturnValue("darwin");

		const client = new AcpClient({
			agentName: "gemini",
			config: { command: "gemini", args: [] },
			cwd: "/tmp",
		});
		await client.connect();

		const spawnOpts = mockSpawn.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(spawnOpts).toBeDefined();
		expect(spawnOpts.shell).toBe(false);
	});

	it("RED→GREEN: passes shell:false on linux", async () => {
		mockPlatform.mockReturnValue("linux");

		const client = new AcpClient({
			agentName: "gemini",
			config: { command: "gemini", args: [] },
			cwd: "/tmp",
		});
		await client.connect();

		const spawnOpts = mockSpawn.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(spawnOpts).toBeDefined();
		expect(spawnOpts.shell).toBe(false);
	});

	it("RED: spawn receives all required options including shell, cwd, env, stdio", async () => {
		mockPlatform.mockReturnValue("win32");

		const client = new AcpClient({
			agentName: "gemini",
			config: { command: "gemini", args: ["--foo"], env: { MY_VAR: "val" } },
			cwd: "/custom/cwd",
		});
		await client.connect();

		// Verify complete spawn call signature
		expect(mockSpawn).toHaveBeenCalledWith(
			"gemini",
			["--foo"],
			expect.objectContaining({
				cwd: "/custom/cwd",
				env: expect.objectContaining({ MY_VAR: "val" }),
				stdio: ["pipe", "pipe", "pipe"],
				shell: true, // PR #1 should add this
			}),
		);
	});
});

// ===========================================================================
// G2: shell:true orphans child processes when killWithEscalation is used
//
// When shell:true on Windows, Node spawns: cmd.exe /d /s /c "command args"
// proc.pid = PID of cmd.exe, NOT the actual agent process.
// proc.kill() kills cmd.exe but the agent process is orphaned.
//
// A proper fix would use `taskkill /T /F /PID <pid>` on Windows to kill
// the entire process tree, or use PID tree discovery.
// ===========================================================================
describe("G2: shell:true process kill documentation (orphan risk)", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	it("RED: killWithEscalation should use process-tree kill on Windows with shell:true", async () => {
		mockPlatform.mockReturnValue("win32");

		const proc = makeFakeProc();
		// On Windows with shell:true, proc.pid is cmd.exe's PID, not the agent's
		proc.pid = 99999; // fake shell wrapper PID
		const mockKill = vi.fn(() => { proc.killed = true; });
		proc.kill = mockKill;

		mockSpawn.mockReturnValue(proc);

		const client = new AcpClient({
			agentName: "gemini",
			config: { command: "gemini", args: [] },
			cwd: "/tmp",
		});
		await client.connect();

		// Verify spawn was called with shell:true (simulating PR #1 behavior)
		const spawnOpts = mockSpawn.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(spawnOpts.shell).toBe(true);

		await client.dispose();

		// The shell wrapper IS killed
		expect(proc.killed).toBe(true);
		expect(mockKill).toHaveBeenCalled();

		// RED: But we have no way to verify that the ACTUAL child process
		// (not cmd.exe) was killed. The real agent process may be orphaned.
		//
		// This test documents the gap. After fixing, we should verify:
		// 1. killWithEscalation uses taskkill /T on win32
		// 2. Or some other process-tree-aware kill mechanism
		//
		// For now: we can only verify the incomplete behavior —
		// kill was called on the shell PID only, not the process tree
	});
});

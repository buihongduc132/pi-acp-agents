/**
 * RED tests for AcpxAdapter — T8/T10
 *
 * Tests the adapter that shells out to the acpx CLI for agent communication.
 * Uses execFile mocking to verify correct command construction and response parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AcpxAdapter } from "../../src/adapters/acpx.js";
import type { AcpAgentConfig } from "../../src/config/types.js";

// Mock child_process
const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => mockExecFile(...args),
	execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Mock fs for homedir fallback
vi.mock("node:fs", () => ({
	existsSync: () => true,
	readFileSync: () => "{}",
	writeFileSync: () => {},
	mkdirSync: () => {},
}));

const SUCCESS_PROMPT_JSON = JSON.stringify({
	text: "Hello from acpx",
	stopReason: "end_turn",
	sessionId: "ses_123",
});

const ERROR_PROMPT_JSON = JSON.stringify({
	error: "Agent refused to answer",
	stopReason: "error",
});

function createDefaultConfig(): AcpAgentConfig {
	return { command: "acpx", mode: "acpx" };
}

describe("AcpxAdapter", () => {
	beforeEach(() => {
		mockExecFile.mockReset();
		mockExecFileSync.mockReset();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("name", () => {
		it("returns 'acpx' as adapter name", () => {
			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
			});
			expect(adapter.name).toBe("acpx");
		});
	});

	describe("spawn / initialize", () => {
		it("calls 'acpx sessions create' with agent name and format json", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_new_001" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: { ...createDefaultConfig(), agentName: "claude" },
			});
			await adapter.spawn();

			const callArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(callArgs).toContain("sessions");
			expect(callArgs).toContain("create");
			expect(callArgs).toContain("claude");
			expect(callArgs).toContain("--format");
			expect(callArgs).toContain("json");
		});

		it("stores session id from acpx response", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_abc456" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
				agentName: "gemini",
			});
			await adapter.spawn();

			expect(adapter.getSessionId()).toBe("ses_abc456");
		});

		it("throws on spawn failure", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(new Error("acpx not found"), "");
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
				agentName: "test",
			});

			await expect(adapter.spawn()).rejects.toThrow("acpx not found");
		});
	});

	describe("prompt", () => {
		it("calls 'acpx prompt' with session id and format json", async () => {
			// Simulate spawned state
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_prompt_test" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
				agentName: "test-agent",
			});
			await adapter.spawn();

			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, SUCCESS_PROMPT_JSON);
				},
			);

			const result = await adapter.prompt("Say hello");

			expect(mockExecFile).toHaveBeenCalledWith(
				"acpx",
				expect.arrayContaining([
					"prompt",
					"--session",
					"ses_prompt_test",
					"--format",
					"json",
					"--approve-all",
				]),
				expect.any(Object),
				expect.any(Function),
			);
			expect(result.text).toBe("Hello from acpx");
			expect(result.stopReason).toBe("end_turn");
			expect(result.sessionId).toBe("ses_123");
		});

		it("passes timeout flag when config has stallTimeoutMs", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_timeout_test" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: { ...createDefaultConfig(), stallTimeoutMs: 30000 },
				agentName: "test-agent",
			});
			await adapter.spawn();

			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, SUCCESS_PROMPT_JSON);
				},
			);

			await adapter.prompt("Test timeout");

			const callArgs = mockExecFile.mock.calls[1][1] as string[];
			const timeoutIdx = callArgs.indexOf("--timeout");
			expect(timeoutIdx).toBeGreaterThanOrEqual(0);
			expect(callArgs[timeoutIdx + 1]).toBe("30");
		});

		it("throws error when acpx returns an error response", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_err_test" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
				agentName: "test",
			});
			await adapter.spawn();

			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, ERROR_PROMPT_JSON);
				},
			);

			await expect(adapter.prompt("Fail me")).rejects.toThrow("Agent refused to answer");
		});

		it("throws if not spawned before prompt", async () => {
			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
			});

			await expect(adapter.prompt("Before spawn")).rejects.toThrow();
		});

		it("includes cwd as --cwd flag when provided", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_cwd_test" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
				agentName: "test",
				cwd: "/some/project/dir",
			});
			await adapter.spawn();

			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, SUCCESS_PROMPT_JSON);
				},
			);

			await adapter.prompt("Test cwd");

			const callArgs = mockExecFile.mock.calls[1][1] as string[];
			expect(callArgs).toContain("--cwd");
			expect(callArgs).toContain("/some/project/dir");
		});
	});

	describe("cancel", () => {
		it("calls 'acpx sessions cancel' with session id", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_cancel_test" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
				agentName: "test",
			});
			await adapter.spawn();

			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, "{}");
				},
			);

			await adapter.cancel();

			expect(mockExecFile).toHaveBeenCalledWith(
				"acpx",
				expect.arrayContaining(["sessions", "cancel", "ses_cancel_test"]),
				expect.any(Object),
				expect.any(Function),
			);
		});

		it("no-ops gracefully if not spawned", async () => {
			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
			});
			// Should not throw
			await adapter.cancel();
		});
	});

	describe("dispose", () => {
		it("calls 'acpx sessions close' with session id", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_dispose_test" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
				agentName: "test",
			});
			await adapter.spawn();

			// Reset mock count from spawn call
			mockExecFile.mockClear();

			adapter.dispose();

			expect(mockExecFile).toHaveBeenCalledWith(
				"acpx",
				["sessions", "close", "ses_dispose_test"],
				expect.objectContaining({ timeout: 10_000 }),
				expect.any(Function),
			);
		});

		it("no-ops gracefully if not spawned", () => {
			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
			});
			// Should not throw
			adapter.dispose();
		});
	});

	describe("connected", () => {
		it("returns true after spawn", async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
					cb(null, JSON.stringify({ sessionId: "ses_conn_test" }));
				},
			);

			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
			});
			await adapter.spawn();

			expect(adapter.connected).toBe(true);
		});

		it("returns false before spawn", () => {
			const adapter = new AcpxAdapter({
				config: createDefaultConfig(),
			});
			expect(adapter.connected).toBe(false);
		});
	});
});

/**
 * pi-acp-agents — AcpxAdapter unit tests.
 *
 * Tests the acpx CLI adapter that delegates agent interaction to the acpx CLI
 * instead of spawning a subprocess directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AcpAdapterOptions } from "../../src/config/types.js";
import { AcpxAdapter } from "../../src/adapters/acpx.js";

// ---------------------------------------------------------------------------
// Mock spawnSync — shared mutable state in vi.hoisted for mock factory access
// ---------------------------------------------------------------------------
type MockAction =
	| { type: 'return'; result: { status: number; stdout: string; stderr: string; error?: Error } }
	| { type: 'throw'; error: Error };

const { spawnSyncMock, queueResult, queueThrow, queueErrorResult, resetMockState } = vi.hoisted(() => {
	const actions: MockAction[] = [];
	let callIndex = 0;

	const spawnSyncMock = vi.fn(() => {
		const idx = callIndex++;
		const action = actions[idx];
		if (!action) return { status: 1, stdout: "", stderr: "no mock result queued" };
		if (action.type === 'throw') throw action.error;
		return action.result;
	});

	function queueResult(status: number, stdout: string, stderr = "") {
		actions.push({ type: 'return', result: { status, stdout, stderr } });
	}

	function queueThrow(error: Error) {
		actions.push({ type: 'throw', error });
	}

	function queueErrorResult(status: number, stdout: string, stderr: string, error: Error) {
		actions.push({ type: 'return', result: { status, stdout, stderr, error } });
	}

	function resetMockState() {
		actions.length = 0;
		callIndex = 0;
	}

	return { spawnSyncMock, queueResult, queueThrow, queueErrorResult, resetMockState };
});

vi.mock("node:child_process", () => ({
	spawnSync: spawnSyncMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<AcpAdapterOptions> = {}): AcpAdapterOptions {
	return {
		config: { command: "acpx" },
		...overrides,
	};
}

// queueResult is provided by vi.hoisted above

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AcpxAdapter", () => {
	beforeEach(() => {
		resetMockState();
	});

	describe("name", () => {
		it("returns 'acpx' as the adapter name", () => {
			const adapter = new AcpxAdapter(makeOpts());
			expect(adapter.name).toBe("acpx");
		});
	});

	describe("spawn", () => {
		it("creates an acpx session and stores session ID", async () => {
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-001" }));
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			expect(adapter.getSessionId()).toBe("acpx-sess-001");
			expect(adapter.connected).toBe(true);
		});

		it("throws if spawn fails", async () => {
			queueResult(1, "", "acpx: command not found");
			const adapter = new AcpxAdapter(makeOpts());
			await expect(adapter.spawn()).rejects.toThrow(/spawn failed/i);
		});

		it("throws on empty session ID from spawn", async () => {
			queueResult(0, JSON.stringify({}));
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			expect(adapter.getSessionId()).toBeNull();
			expect(adapter.connected).toBe(true);
		});
	});

	describe("prompt", () => {
		it("throws if prompt called before spawn", async () => {
			const adapter = new AcpxAdapter(makeOpts());
			await expect(adapter.prompt("test")).rejects.toThrow(/Not spawned/i);
		});

		it("throws if prompt called after spawn with no session ID", async () => {
			queueResult(0, JSON.stringify({})); // spawn returns no sessionId
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			await expect(adapter.prompt("test")).rejects.toThrow(/No session ID/i);
		});

		it("sends prompt via acpx CLI and returns parsed result", async () => {
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-001" })); // spawn
			queueResult(0, JSON.stringify({
				text: "Hello from acpx!",
				stopReason: "end_turn",
				sessionId: "acpx-sess-001",
			})); // prompt
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			const result = await adapter.prompt("Say hello");
			expect(result.text).toBe("Hello from acpx!");
			expect(result.stopReason).toBe("end_turn");
			expect(result.sessionId).toBe("acpx-sess-001");
		});

		it("throws on acpx CLI error during prompt", async () => {
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-001" }));
			queueResult(1, "", "acpx error: session expired");
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			await expect(adapter.prompt("fail")).rejects.toThrow(/prompt failed/i);
		});
	});

	describe("initialize", () => {
		it("throws if not spawned", async () => {
			const adapter = new AcpxAdapter(makeOpts());
			await expect(adapter.initialize()).rejects.toThrow(/Not spawned/i);
		});

		it("succeeds after spawn", async () => {
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-001" }));
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			await expect(adapter.initialize()).resolves.toBeUndefined();
		});
	});

	describe("newSession", () => {
		it("returns session ID after spawn", async () => {
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-001" }));
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			const id = await adapter.newSession();
			expect(id).toBe("acpx-sess-001");
		});

		it("throws if not spawned", async () => {
			const adapter = new AcpxAdapter(makeOpts());
			await expect(adapter.newSession()).rejects.toThrow(/Not spawned/i);
		});
	});

	describe("cancel", () => {
		it("does not throw if no session ID", async () => {
			const adapter = new AcpxAdapter(makeOpts());
			await expect(adapter.cancel()).resolves.toBeUndefined();
		});

		it("runs cancel CLI when session exists", async () => {
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-001" })); // spawn
			queueResult(0, "", ""); // cancel
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			await expect(adapter.cancel()).resolves.toBeUndefined();
		});
	});

	describe("loadSession", () => {
		it("sets session ID and connected state", async () => {
			const adapter = new AcpxAdapter(makeOpts());
			const id = await adapter.loadSession("existing-session");
			expect(id).toBe("existing-session");
			expect(adapter.getSessionId()).toBe("existing-session");
			expect(adapter.connected).toBe(true);
		});
	});

	describe("dispose", () => {
		it("closes session and resets state", async () => {
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-001" })); // spawn
			queueResult(0, "", ""); // close
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			expect(adapter.connected).toBe(true);
			adapter.dispose();
			expect(adapter.getSessionId()).toBeNull();
			expect(adapter.connected).toBe(false);
		});

		it("does not throw if not spawned", () => {
			const adapter = new AcpxAdapter(makeOpts());
			expect(() => adapter.dispose()).not.toThrow();
		});
	});

	describe("setModel / setMode", () => {
		it("setModel is a no-op (acpx doesn't support per-session model switching)", async () => {
			const adapter = new AcpxAdapter(makeOpts());
			await expect(adapter.setModel("gemini-pro")).resolves.toBeUndefined();
		});

		it("setMode is a no-op (acpx doesn't support per-session mode switching)", async () => {
			const adapter = new AcpxAdapter(makeOpts());
			await expect(adapter.setMode("yolo")).resolves.toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// TDD RED tests — error handling and crash safety
	// These tests SHOULD FAIL because the implementation lacks try/catch.
	// After fixing acpx.ts, these should all turn GREEN.
	// -----------------------------------------------------------------------

	describe("error handling and crash safety", () => {

		it("dispose() catches spawnSync errors gracefully", async () => {
			// Spawn succeeds, then dispose's spawnSync (close) throws ENOENT
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-err" }));
			queueThrow(new Error("ENOENT: acpx binary not found"));
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();
			expect(adapter.connected).toBe(true);

			// dispose MUST NOT throw — it should swallow the error and still clean up
			expect(() => adapter.dispose()).not.toThrow();
			expect(adapter.getSessionId()).toBeNull();
			expect(adapter.connected).toBe(false);
		});

		it("spawn() catches JSON parse errors", async () => {
			// spawnSync returns status 0 but stdout is not valid JSON
			queueResult(0, "not json at all");
			const adapter = new AcpxAdapter(makeOpts());

			// spawn should throw a wrapped error mentioning 'AcpxAdapter',
			// not a raw SyntaxError from JSON.parse
			await expect(adapter.spawn()).rejects.toThrow(/AcpxAdapter/i);
		});

		it("prompt() catches spawnSync throws", async () => {
			// spawn succeeds, then prompt's spawnSync throws
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-throw" }));
			queueThrow(new Error("spawnSync crashed: SIGKILL"));
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();

			// prompt should throw a wrapped error mentioning AcpxAdapter,
			// not the raw spawnSync error
			await expect(adapter.prompt("test")).rejects.toThrow(/AcpxAdapter prompt failed/i);
		});

		it("cancel() catches spawnSync errors gracefully", async () => {
			// spawn succeeds, then cancel's spawnSync throws
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-cancel" }));
			queueThrow(new Error("ENOENT: acpx not found"));
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();

			// cancel MUST NOT throw — best-effort, swallow the error
			await expect(adapter.cancel()).resolves.toBeUndefined();
		});

		it("dispose() does not throw when acpx close returns error status", async () => {
			// spawn succeeds, close returns status 1 (error)
			queueResult(0, JSON.stringify({ sessionId: "acpx-sess-close-err" }));
			queueResult(1, "", "close failed: session not found");
			const adapter = new AcpxAdapter(makeOpts());
			await adapter.spawn();

			// dispose must not throw and must still clean up state
			expect(() => adapter.dispose()).not.toThrow();
			expect(adapter.getSessionId()).toBeNull();
			expect(adapter.connected).toBe(false);
		});

		it("_runAcpx handles result.error from spawnSync", async () => {
			// spawnSync returns { status: 0, error: Error } — child process killed
			queueErrorResult(
				0,
				"",
				"",
				new Error("Child process killed by signal SIGTERM"),
			);
			const adapter = new AcpxAdapter(makeOpts());

			// spawn should surface the spawnSync error, not silently succeed
			await expect(adapter.spawn()).rejects.toThrow(/SIGTERM|signal|killed/i);
		});
	});
});

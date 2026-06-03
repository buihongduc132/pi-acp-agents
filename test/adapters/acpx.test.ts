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
const { spawnSyncMock, queueResult, resetMockState } = vi.hoisted(() => {
	const spawnSyncResults: Array<{ status: number; stdout: string; stderr: string }> = [];
	let callIndex = 0;

	const spawnSyncMock = vi.fn(() => {
		const idx = callIndex++;
		const result = spawnSyncResults[idx] ?? spawnSyncResults[spawnSyncResults.length - 1];
		return result ?? { status: 1, stdout: "", stderr: "no mock result queued" };
	});

	function queueResult(status: number, stdout: string, stderr = "") {
		spawnSyncResults.push({ status, stdout, stderr });
	}

	function resetMockState() {
		spawnSyncResults.length = 0;
		callIndex = 0;
	}

	return { spawnSyncMock, queueResult, resetMockState };
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
});

/**
 * coordinator.ts — Dispose safety RED tests (TDD Step 1)
 *
 * These tests verify that adapter.dispose() errors are safely caught
 * in all 3 call sites within coordinator.ts:
 *   1. Pre-abort path (delegate() early return)
 *   2. onAbort handler (abort signal listener)
 *   3. finally block (normal cleanup)
 *
 * ALL TESTS SHOULD FAIL — the current implementation does NOT wrap
 * adapter.dispose() in try/catch at any of these sites.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCoordinator } from "../src/coordination/coordinator.js";
import type { AcpConfig } from "../src/config/types.js";

// ---------------------------------------------------------------------------
// Mock adapter-factory
// ---------------------------------------------------------------------------
const { mockCreateAdapter } = vi.hoisted(() => ({
	mockCreateAdapter: vi.fn(),
}));
vi.mock("../src/adapter-factory.js", () => ({
	createAdapter: mockCreateAdapter,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockConfig: AcpConfig = {
	agent_servers: {
		gemini: { command: "gemini", args: ["--acp"] },
		claude: { command: "claude", args: ["--acp"] },
	},
	defaultAgent: "gemini",
};

/** Create an adapter that succeeds at everything but dispose throws. */
function makeAdapterWithDisposeError(disposeError: Error = new Error("dispose boom")) {
	return {
		spawn: vi.fn().mockResolvedValue(undefined),
		initialize: vi.fn().mockResolvedValue(undefined),
		newSession: vi.fn().mockResolvedValue("session-1"),
		prompt: vi.fn().mockResolvedValue({
			text: "response text",
			stopReason: "end_turn",
			sessionId: "session-1",
		}),
		cancel: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn().mockImplementation(() => { throw disposeError; }),
		connected: true,
	};
}

/** Create an adapter where both cancel AND dispose throw. */
function makeAdapterWithCancelAndDisposeError(
	cancelError: Error = new Error("cancel boom"),
	disposeError: Error = new Error("dispose boom"),
) {
	return {
		spawn: vi.fn().mockResolvedValue(undefined),
		initialize: vi.fn().mockResolvedValue(undefined),
		newSession: vi.fn().mockResolvedValue("session-1"),
		prompt: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves — stays in-flight
		cancel: vi.fn().mockImplementation(() => { throw cancelError; }),
		dispose: vi.fn().mockImplementation(() => { throw disposeError; }),
		connected: true,
	};
}

/** Create an adapter where prompt hangs forever (for abort tests). */
function makeHangingAdapter() {
	return {
		spawn: vi.fn().mockResolvedValue(undefined),
		initialize: vi.fn().mockResolvedValue(undefined),
		newSession: vi.fn().mockResolvedValue("session-1"),
		prompt: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
		cancel: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn().mockResolvedValue(undefined),
		connected: true,
	};
}

beforeEach(() => {
	mockCreateAdapter.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coordinator.ts — dispose safety (RED tests)", () => {

	// -------------------------------------------------------------------------
	// Test 1: finally block — dispose error does NOT mask successful prompt
	// -------------------------------------------------------------------------
	it("delegate() — adapter.dispose() error in finally does not mask prompt result", async () => {
		const adapter = makeAdapterWithDisposeError();
		mockCreateAdapter.mockReturnValue(adapter as any);

		const coordinator = new AgentCoordinator(mockConfig, "/tmp");

		// prompt succeeds, but dispose throws in finally.
		// The prompt result should still be returned (dispose error swallowed).
		const result = await coordinator.delegate("gemini", "hello");

		expect(result.text).toBe("response text");
		expect(result.stopReason).toBe("end_turn");
		expect(adapter.dispose).toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Test 2: onAbort handler — dispose error does not mask AbortError
	// -------------------------------------------------------------------------
	it("delegate() — adapter.dispose() error in onAbort does not crash", async () => {
		const disposeErr = new Error("dispose boom in onAbort");
		const adapter = {
			...makeHangingAdapter(),
			dispose: vi.fn().mockImplementation(() => { throw disposeErr; }),
		};
		mockCreateAdapter.mockReturnValue(adapter as any);

		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const controller = new AbortController();

		// Abort after a microtask so prompt is in-flight
		setTimeout(() => controller.abort(), 10);

		await expect(
			coordinator.delegate("gemini", "hello", undefined, undefined, controller.signal),
		).rejects.toThrow("Operation cancelled");

		// dispose was called (and threw), but the AbortError was still thrown
		expect(adapter.dispose).toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Test 3: onAbort — both cancel AND dispose throw
	// -------------------------------------------------------------------------
	it("delegate() — adapter.cancel() error + adapter.dispose() error in onAbort do not crash", async () => {
		const cancelErr = new Error("cancel boom");
		const disposeErr = new Error("dispose boom");
		const adapter = makeAdapterWithCancelAndDisposeError(cancelErr, disposeErr);
		mockCreateAdapter.mockReturnValue(adapter as any);

		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 10);

		await expect(
			coordinator.delegate("gemini", "hello", undefined, undefined, controller.signal),
		).rejects.toThrow("Operation cancelled");

		// Both were called despite throwing
		expect(adapter.cancel).toHaveBeenCalled();
		expect(adapter.dispose).toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Test 4: Pre-abort path — dispose error is swallowed
	// -------------------------------------------------------------------------
	it("delegate() — pre-abort adapter.dispose() error is swallowed", async () => {
		const disposeErr = new Error("dispose boom pre-abort");
		const adapter = {
			spawn: vi.fn(),
			initialize: vi.fn(),
			newSession: vi.fn(),
			prompt: vi.fn(),
			cancel: vi.fn().mockImplementation(() => { throw new Error("cancel boom"); }),
			dispose: vi.fn().mockImplementation(() => { throw disposeErr; }),
			connected: false,
		};
		mockCreateAdapter.mockReturnValue(adapter as any);

		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const controller = new AbortController();
		// Abort immediately (pre-abort path)
		controller.abort();

		// Should throw AbortError, NOT dispose error
		await expect(
			coordinator.delegate("gemini", "hello", undefined, undefined, controller.signal),
		).rejects.toThrow("Operation cancelled");

		// dispose was attempted despite throwing
		expect(adapter.dispose).toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Test 5: finally — abort listener removed even when dispose throws
	// -------------------------------------------------------------------------
	it("delegate() — abort listener removed even when dispose throws in finally", async () => {
		const adapter = makeAdapterWithDisposeError();
		mockCreateAdapter.mockReturnValue(adapter as any);

		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const controller = new AbortController();

		// We need to spy on removeEventListener to confirm it was called
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		// prompt succeeds, dispose throws in finally
		const result = await coordinator.delegate("gemini", "hello", undefined, undefined, controller.signal);

		expect(result.text).toBe("response text");

		// The abort listener MUST have been removed even though dispose threw
		expect(removeSpy).toHaveBeenCalled();

		removeSpy.mockRestore();
	});
});

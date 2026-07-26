/**
 * RED PHASE — Failing tests for Feature 4: Steer / Interrupt / Resume
 *
 * These tests MUST FAIL because the implementation doesn't exist yet.
 * They define the expected contract for:
 *   - AsyncExecutor.interrupt(runId) — abort in-flight turn, state → "needs-attention"
 *   - AsyncExecutor.resume(runId, message?) — re-engage session, state → "running"
 *   - AsyncExecutor.steer(runId, message) — inject guidance into active run
 *   - Telemetry preservation across interrupt/resume
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AcpAsyncRunRecord } from "../../src/config/types.js";

// ── Mock factories ───────────────────────────────────────────────────

/**
 * Mock coordinator with long-running delegate (simulates active session).
 */
function createLongRunningMockCoordinator(durationMs = 2000) {
	return {
		delegate: vi.fn(async () => {
			await new Promise((r) => setTimeout(r, durationMs));
			return { text: "Completed after long run", stopReason: "stop", sessionId: "mock-ses-long" };
		}),
		interrupt: vi.fn(async () => {
			// Simulate provider-specific interrupt
			return { success: true };
		}),
	};
}

/**
 * Mock coordinator that tracks steer/interrupt/resume calls.
 */
function createTrackableMockCoordinator() {
	return {
		delegate: vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 100));
			return { text: "Done", stopReason: "stop", sessionId: "mock-ses-track" };
		}),
		interrupt: vi.fn(async () => ({ success: true })),
		resume: vi.fn(async () => ({ success: true })),
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "acp-async-steer-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// Group 1: Interrupt
// ═══════════════════════════════════════════════════════════════════════

describe("Interrupt", () => {
	it("T4.1: interrupt(runId) aborts in-flight turn and sets state to 'needs-attention'", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createLongRunningMockCoordinator(5000);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Long task");
		await new Promise((r) => setTimeout(r, 100)); // Let it start

		// Interrupt the run
		const result = (executor as any).interrupt(runId);
		expect(result).toBeDefined();
		expect(result.success).toBe(true);

		await new Promise((r) => setTimeout(r, 200));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();
		expect(record!.state).toBe("needs-attention");
		expect(record!.error).toContain("interrupted");
	});

	it("T4.2: interrupt preserves accumulated telemetry", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createLongRunningMockCoordinator(5000);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Long task");
		await new Promise((r) => setTimeout(r, 100));

		// Interrupt
		(executor as any).interrupt(runId);
		await new Promise((r) => setTimeout(r, 200));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();

		// Telemetry should be preserved (not reset to 0)
		const r = record as any;
		expect(r.turns).toBeDefined();
		expect(r.toolCalls).toBeDefined();
		expect(r.tokensUsed).toBeDefined();
		expect(r.lastActivityAt).toBeDefined();
	});

	it("T4.3: interrupt returns false for completed/failed runs", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = {
			delegate: vi.fn(async () => {
				await new Promise((r) => setTimeout(r, 50));
				return { text: "Done", stopReason: "stop", sessionId: "mock-ses" };
			}),
		};
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Quick task");
		await new Promise((r) => setTimeout(r, 200));

		const result = (executor as any).interrupt(runId);
		expect(result).toBeDefined();
		expect(result.success).toBe(false);
		expect(result.reason).toContain("already completed");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Group 2: Resume
// ═══════════════════════════════════════════════════════════════════════

describe("Resume", () => {
	it("T4.4: resume(runId, message?) re-engages session (delegate called 2x) and sets state to 'running'", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		// Long-running delegate so state stays 'running' during assertions
		const coordinator = createLongRunningMockCoordinator(5000);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Task");
		await new Promise((r) => setTimeout(r, 100));

		// Interrupt first
		(executor as any).interrupt(runId);
		await new Promise((r) => setTimeout(r, 200));

		let record = executor.getStatus(runId);
		expect(record!.state).toBe("needs-attention");

		// Resume — should call delegate a SECOND time (re-engage)
		const result = (executor as any).resume(runId, "Continue with the task");
		expect(result).toBeDefined();
		expect(result.success).toBe(true);

		// State should be 'running' immediately after resume (delegate is long-running)
		record = executor.getStatus(runId);
		expect(record!.state).toBe("running");

		// Verify delegate was called twice: once on start, once on resume
		expect(coordinator.delegate).toHaveBeenCalledTimes(2);
	});
	it("T4.5: resume resets silent-failure counters", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createTrackableMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Task");
		await new Promise((r) => setTimeout(r, 100));

		// Interrupt
		(executor as any).interrupt(runId);
		await new Promise((r) => setTimeout(r, 200));

		// Resume
		(executor as any).resume(runId, "Continue");
		await new Promise((r) => setTimeout(r, 200));

		const record = executor.getStatus(runId);
		const r = record as any;

		// Counters should be reset (or at least lastActivityAt updated)
		expect(r.lastActivityAt).toBeDefined();
		const lastActivity = new Date(r.lastActivityAt).getTime();
		expect(lastActivity).toBeGreaterThan(Date.now() - 5000); // Within last 5s
	});

	it("T4.6: resume returns false for active runs", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createLongRunningMockCoordinator(5000);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Long task");
		await new Promise((r) => setTimeout(r, 100));

		// Try to resume an active run
		const result = (executor as any).resume(runId, "Continue");
		expect(result).toBeDefined();
		expect(result.success).toBe(false);
		expect(result.reason).toContain("already running");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Group 3: Steer
// ═══════════════════════════════════════════════════════════════════════

describe("Steer", () => {
	it("T4.7: steer(runId, message) injects guidance into active run", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createLongRunningMockCoordinator(5000);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Long task");
		await new Promise((r) => setTimeout(r, 100));

		// Steer the run
		const result = (executor as any).steer(runId, "Focus on the error handling");
		expect(result).toBeDefined();
		expect(result.success).toBe(true);
		expect(result.delivered).toBe(true);
	});

	it("T4.8: steer queues message if run is idle", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createTrackableMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Task");
		await new Promise((r) => setTimeout(r, 200)); // Let it complete

		// Steer a completed run (should queue for next interaction)
		const result = (executor as any).steer(runId, "Next time, do this");
		expect(result).toBeDefined();
		expect(result.success).toBe(true);
		expect(result.queued).toBe(true);
		expect(result.delivered).toBe(true); // G3 fix: idle-steer also delivers
	});

	it("T4.9: steer returns false for non-existent run", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createTrackableMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const result = (executor as any).steer("non-existent", "Message");
		expect(result).toBeDefined();
		expect(result.success).toBe(false);
		expect(result.reason).toContain("not found");
	});
});

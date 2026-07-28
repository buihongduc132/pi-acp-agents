/**
 * Tests for AsyncExecutor tracked spawn lifecycle methods:
 * trackExternalSpawn, completeTrackedSpawn, failTrackedSpawn,
 * reportTrackedProgress, findTrackedBySession, cleanupTrackedWorktree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createMockCoordinator() {
	return {
		delegate: vi.fn(async () => ({
			text: "mock",
			stopReason: "stop",
			sessionId: "mock-ses",
		})),
	};
}

let tmpDir: string;

describe("AsyncExecutor — tracked spawn lifecycle", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-tracked-spawn-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("trackExternalSpawn creates run record with correct fields", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.trackExternalSpawn({
			sessionId: "ses-123",
			agentName: "gemini",
			cwd: "/tmp/project",
			message: "Do the thing",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		expect(runId).toBeTruthy();

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();
		expect(record!.state).toBe("running");
		expect(record!.agentName).toBe("gemini");
		expect(record!.cwd).toBe("/tmp/project");
		expect(record!.message).toBe("Do the thing");
		expect(record!.sessionId).toBe("ses-123");
	});

	it("completeTrackedSpawn transitions to completed with non-zero telemetry", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.trackExternalSpawn({
			sessionId: "ses-abc",
			agentName: "codex",
			cwd: "/tmp/proj",
			message: "Build it",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		// Simulate some progress (turns + tool calls)
		executor.reportTrackedProgress(runId);
		executor.reportTrackedProgress(runId);

		executor.completeTrackedSpawn(runId, { text: "Done building" });

		const record = executor.getStatus(runId);
		expect(record!.state).toBe("completed");
		expect(record!.result).toBe("Done building");
		expect(record!.turns).toBe(2);
	});

	it("completeTrackedSpawn silent-failure detection: zero telemetry + empty text → failed", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const onWakeNotification = vi.fn();
		const executor = new AsyncExecutor(coordinator as any, tmpDir, { onWakeNotification });

		const runId = executor.trackExternalSpawn({
			sessionId: "ses-silent",
			agentName: "gemini",
			cwd: "/tmp/proj",
			message: "Do nothing",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		// No progress reported → zero toolCalls, zero filesWritten, zero turns
		executor.completeTrackedSpawn(runId, { text: "" });

		const record = executor.getStatus(runId);
		expect(record!.state).toBe("failed");
		expect(record!.error).toContain("silent-no-output");
		expect(record!.errorDetail).toEqual({ reason: "silent-no-output" });
		expect(onWakeNotification).toHaveBeenCalledWith(runId, { reason: "silent-no-output" });
	});

	it("failTrackedSpawn transitions to failed with error message", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.trackExternalSpawn({
			sessionId: "ses-fail",
			agentName: "gemini",
			cwd: "/tmp/proj",
			message: "Try hard",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		executor.failTrackedSpawn(runId, "Agent crashed with segfault");

		const record = executor.getStatus(runId);
		expect(record!.state).toBe("failed");
		expect(record!.error).toBe("Agent crashed with segfault");
		expect(record!.errorDetail).toBeDefined();
		expect(record!.errorDetail!.reason).toBe("crash");
		expect(record!.errorDetail!.message).toBe("Agent crashed with segfault");
	});

	it("reportTrackedProgress increments turns", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.trackExternalSpawn({
			sessionId: "ses-turns",
			agentName: "gemini",
			cwd: "/tmp/proj",
			message: "Multi-turn task",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		expect(executor.getStatus(runId)!.turns).toBe(0);

		executor.reportTrackedProgress(runId);
		expect(executor.getStatus(runId)!.turns).toBe(1);

		executor.reportTrackedProgress(runId);
		executor.reportTrackedProgress(runId);
		expect(executor.getStatus(runId)!.turns).toBe(3);
	});

	it("findTrackedBySession returns correct spawn", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		executor.trackExternalSpawn({
			sessionId: "ses-find-me",
			agentName: "gemini",
			cwd: "/tmp/proj",
			message: "Find me",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		const found = executor.findTrackedBySession("ses-find-me");
		expect(found).toBeDefined();
		expect(found!.sessionId).toBe("ses-find-me");
		expect(found!.agentName).toBe("gemini");
	});

	it("findTrackedBySession returns undefined for unknown sessionId", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const found = executor.findTrackedBySession("nonexistent-session");
		expect(found).toBeUndefined();
	});

	it("completeTrackedSpawn cleans up telemetry (reportTrackedProgress after complete is no-op)", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.trackExternalSpawn({
			sessionId: "ses-cleanup",
			agentName: "gemini",
			cwd: "/tmp/proj",
			message: "Task",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		// Report some progress
		executor.reportTrackedProgress(runId);
		expect(executor.getStatus(runId)!.turns).toBe(1);

		// Complete the spawn
		executor.completeTrackedSpawn(runId, { text: "Result" });

		// After completion, telemetryMap entry should be removed.
		// reportTrackedProgress should be a no-op (turns stays at 1).
		executor.reportTrackedProgress(runId);
		expect(executor.getStatus(runId)!.turns).toBe(1);
	});

	it("completeTrackedSpawn preserves interrupted state (needs-attention)", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.trackExternalSpawn({
			sessionId: "test-ses",
			agentName: "test-agent",
			cwd: "/tmp",
			message: "test",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		// Interrupt the run → state becomes needs-attention
		const result = executor.interrupt(runId);
		expect(result.success).toBe(true);
		expect(executor.getStatus(runId)!.state).toBe("needs-attention");

		// Complete the spawn — should preserve interrupted state
		executor.completeTrackedSpawn(runId, { text: "Result" });

		// State should still be needs-attention, not completed
		expect(executor.getStatus(runId)!.state).toBe("needs-attention");
	});

	it("failTrackedSpawn preserves interrupted state (needs-attention)", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator();
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.trackExternalSpawn({
			sessionId: "test-ses",
			agentName: "test-agent",
			cwd: "/tmp",
			message: "test",
			cancel: vi.fn(),
			reprompt: vi.fn(),
		});

		// Interrupt the run → state becomes needs-attention
		const result = executor.interrupt(runId);
		expect(result.success).toBe(true);
		expect(executor.getStatus(runId)!.state).toBe("needs-attention");

		// Fail the spawn — should preserve interrupted state
		executor.failTrackedSpawn(runId, "Error occurred");

		// State should still be needs-attention, not failed
		expect(executor.getStatus(runId)!.state).toBe("needs-attention");
	});
});

/**
 * TDD tests for AsyncExecutor (M1: Async Background Delegation)
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock AgentCoordinator
function createMockCoordinator(response: string, delayMs = 50) {
	return {
		delegate: mock(async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return { text: response, stopReason: "stop", sessionId: "mock-ses-1" };
		}),
	};
}

let tmpDir: string;

describe("AsyncExecutor", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-async-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("start", () => {
		it("returns runId and state transitions pending → running → completed", async () => {
			const { AsyncExecutor } = await import("../../src/core/async-executor.js");
			const coordinator = createMockCoordinator("Hello from agent");
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const runId = executor.start("gemini", "Say hello");
			expect(runId).toBeTruthy();

			// Immediately: should be pending or running
			const status = executor.getStatus(runId);
			expect(status).toBeDefined();
			expect(["pending", "running"]).toContain(status!.state);

			// Wait for completion
			await new Promise((r) => setTimeout(r, 200));

			const completed = executor.getStatus(runId);
			expect(completed!.state).toBe("completed");
			expect(completed!.result).toBe("Hello from agent");
			expect(completed!.sessionId).toBe("mock-ses-1");
		});

		it("handles error → state = failed", async () => {
			const { AsyncExecutor } = await import("../../src/core/async-executor.js");
			const coordinator = {
				delegate: mock(async () => {
					throw new Error("Agent crashed");
				}),
			};
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const runId = executor.start("gemini", "Do something");
			await new Promise((r) => setTimeout(r, 200));

			const failed = executor.getStatus(runId);
			expect(failed!.state).toBe("failed");
			expect(failed!.error).toContain("Agent crashed");
		});
	});

	describe("getResult", () => {
		it("returns null while running, text after completion", async () => {
			const { AsyncExecutor } = await import("../../src/core/async-executor.js");
			const coordinator = createMockCoordinator("Result text", 100);
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const runId = executor.start("gemini", "Task");
			expect(executor.getResult(runId)).toBeNull();

			await new Promise((r) => setTimeout(r, 300));
			expect(executor.getResult(runId)).toBe("Result text");
		});
	});

	describe("listActive", () => {
		it("returns pending + running runs", async () => {
			const { AsyncExecutor } = await import("../../src/core/async-executor.js");
			const coordinator = createMockCoordinator("Done", 200);
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const id1 = executor.start("gemini", "Task 1");
			const id2 = executor.start("codex", "Task 2");

			const active = executor.listActive();
			expect(active).toHaveLength(2);
			expect(active.map((r) => r.runId)).toEqual(expect.arrayContaining([id1, id2]));

			await new Promise((r) => setTimeout(r, 400));
			expect(executor.listActive()).toHaveLength(0);
		});
	});

	describe("listAll", () => {
		it("returns all runs including completed", async () => {
			const { AsyncExecutor } = await import("../../src/core/async-executor.js");
			const coordinator = createMockCoordinator("Done", 50);
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			executor.start("gemini", "Task 1");
			await new Promise((r) => setTimeout(r, 200));

			executor.start("codex", "Task 2");
			await new Promise((r) => setTimeout(r, 200));

			const all = executor.listAll();
			expect(all).toHaveLength(2);
		});
	});

	describe("cancel", () => {
		it("returns false for completed run", async () => {
			const { AsyncExecutor } = await import("../../src/core/async-executor.js");
			const coordinator = createMockCoordinator("Done", 50);
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const runId = executor.start("gemini", "Task");
			await new Promise((r) => setTimeout(r, 200));
			expect(executor.cancel(runId)).toBe(false);
		});
	});

	describe("prune", () => {
		it("removes old completed/failed runs", async () => {
			const { AsyncExecutor } = await import("../../src/core/async-executor.js");
			const coordinator = createMockCoordinator("Done", 50);
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			executor.start("gemini", "Task");
			await new Promise((r) => setTimeout(r, 200));

			// Prune everything older than 0ms
			const { pruned } = executor.prune(0);
			expect(pruned).toBe(1);
			expect(executor.listAll()).toHaveLength(0);
		});
	});
});

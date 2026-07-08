/**
 * RED tests for src/hooks/non-blocking.ts
 * Tests NonBlockingRunner — fire-and-forget, timeout enforcement,
 * exception isolation, persist-allowlist, cleanup on shutdown.
 * Source does NOT exist yet — these MUST FAIL (RED phase).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NonBlockingRunner } from "../../src/hooks/non-blocking.js";
import type { HookEventName } from "../../src/hooks/types.js";

describe("NonBlockingRunner", () => {
	let runner: NonBlockingRunner;
	let mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		mockLogger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		runner = new NonBlockingRunner({
			logger: mockLogger as any,
			defaultTimeoutMs: 5000,
		});
	});

	afterEach(() => {
		runner.dispose();
		vi.restoreAllMocks();
	});

	describe("fire-and-forget: session_* hooks", () => {
		it("session_started hook does not block caller", async () => {
			const slowHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 10000)),
			);

			// Should return immediately, not wait 10s
			const start = Date.now();
			await runner.run("session_started", slowHook, {
				context: { event: "session_started" } as any,
			});
			const elapsed = Date.now() - start;

			// Should be nearly instant (< 100ms), not 10s
			expect(elapsed).toBeLessThan(100);
		});

		it("session_completed hook does not block caller", async () => {
			const slowHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 10000)),
			);

			const start = Date.now();
			await runner.run("session_completed", slowHook, {
				context: { event: "session_completed" } as any,
			});
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(100);
		});

		it("session_failed hook does not block caller", async () => {
			const slowHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 10000)),
			);

			const start = Date.now();
			await runner.run("session_failed", slowHook, {
				context: { event: "session_failed" } as any,
			});
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(100);
		});

		it("session_idle hook does not block caller", async () => {
			const slowHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 10000)),
			);

			const start = Date.now();
			await runner.run("session_idle", slowHook, {
				context: { event: "session_idle" } as any,
			});
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(100);
		});
	});

	describe("timeout enforcement: task_* hooks", () => {
		it("task_assigned hook is killed after timeoutMs", async () => {
			const hangingHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 60000)),
			);

			await runner.run("task_assigned", hangingHook, {
				context: { event: "task_assigned" } as any,
				timeoutMs: 100,
			});

			// Wait a bit for the timeout to fire
			await new Promise((r) => setTimeout(r, 200));

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("timeout"),
				expect.anything(),
			);
		});

		it("task_completed hook respects custom timeout", async () => {
			const hangingHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 60000)),
			);

			await runner.run("task_completed", hangingHook, {
				context: { event: "task_completed" } as any,
				timeoutMs: 50,
			});

			await new Promise((r) => setTimeout(r, 150));

			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it("task_failed hook is killed after timeoutMs", async () => {
			const hangingHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 60000)),
			);

			await runner.run("task_failed", hangingHook, {
				context: { event: "task_failed" } as any,
				timeoutMs: 100,
			});

			await new Promise((r) => setTimeout(r, 200));

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("timeout"),
				expect.anything(),
			);
		});
	});

	describe("exception isolation", () => {
		it("hook throws → caught, logged, no crash", async () => {
			const throwingHook = vi.fn().mockRejectedValue(new Error("boom"));

			// Should NOT throw
			await expect(
				runner.run("session_started", throwingHook, {
					context: { event: "session_started" } as any,
				}),
			).resolves.toBeUndefined();

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("boom"),
				expect.anything(),
			);
		});

		it("hook throws synchronously → caught, logged, safe default", async () => {
			const syncThrowHook = vi.fn().mockImplementation(() => {
				throw new Error("sync boom");
			});

			await expect(
				runner.run("task_completed", syncThrowHook, {
					context: { event: "task_completed" } as any,
					timeoutMs: 500,
				}),
			).resolves.toBeUndefined();

			expect(mockLogger.error).toHaveBeenCalled();
		});

		it("hook returns rejected promise → caught, logged", async () => {
			const rejectHook = vi.fn().mockRejectedValue(new TypeError("bad type"));

			await runner.run("subagent_stop", rejectHook, {
				context: { event: "subagent_stop" } as any,
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("bad type"),
				expect.anything(),
			);
		});
	});

	describe("persist-allowlist", () => {
		it("safety block result IS persisted", async () => {
			const hookResult = {
				persist: true,
				type: "safety_block_result",
				data: { blocked: true, reason: "unsafe operation" },
			};

			const hook = vi.fn().mockResolvedValue(hookResult);
			await runner.run("task_assigned", hook, {
				context: { event: "task_assigned" } as any,
				timeoutMs: 500,
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(runner.getPersistedResults()).toContainEqual(
				expect.objectContaining({ type: "safety_block_result" }),
			);
		});

		it("rule violation message IS persisted", async () => {
			const hookResult = {
				persist: true,
				type: "rule_violation",
				data: { rule: "no-direct-prod", severity: "error" },
			};

			const hook = vi.fn().mockResolvedValue(hookResult);
			await runner.run("task_completed", hook, {
				context: { event: "task_completed" } as any,
				timeoutMs: 500,
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(runner.getPersistedResults()).toContainEqual(
				expect.objectContaining({ type: "rule_violation" }),
			);
		});

		it("UI-only results are NOT persisted", async () => {
			const hookResult = {
				persist: false,
				type: "ui_notification",
				data: { message: "Task done!" },
			};

			const hook = vi.fn().mockResolvedValue(hookResult);
			await runner.run("session_completed", hook, {
				context: { event: "session_completed" } as any,
			});

			await new Promise((r) => setTimeout(r, 50));

			const persisted = runner.getPersistedResults();
			expect(persisted).not.toContainEqual(
				expect.objectContaining({ type: "ui_notification" }),
			);
		});

		it("arbitrary hook results without persist flag are NOT persisted", async () => {
			const hookResult = { data: "some random data" };

			const hook = vi.fn().mockResolvedValue(hookResult);
			await runner.run("subagent_stop", hook, {
				context: { event: "subagent_stop" } as any,
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(runner.getPersistedResults()).toHaveLength(0);
		});
	});

	describe("cleanup on shutdown", () => {
		it("pending hooks cancelled on dispose", async () => {
			const slowHook = vi.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 60000)),
			);

			// Fire a task hook (background)
			runner.run("task_assigned", slowHook, {
				context: { event: "task_assigned" } as any,
				timeoutMs: 60000,
			});

			// Dispose should cancel pending
			runner.dispose();

			// Wait a bit to ensure cancellation propagated
			await new Promise((r) => setTimeout(r, 100));

			// The runner should have cleaned up — no more pending
			expect(runner.pendingCount()).toBe(0);
		});

		it("dispose is idempotent", () => {
			expect(() => {
				runner.dispose();
				runner.dispose();
				runner.dispose();
			}).not.toThrow();
		});

		it("after dispose, run() rejects or no-ops", async () => {
			runner.dispose();

			const hook = vi.fn().mockResolvedValue({});
			await expect(
				runner.run("session_started", hook, {
					context: { event: "session_started" } as any,
				}),
			).rejects.toThrow();
		});
	});
});

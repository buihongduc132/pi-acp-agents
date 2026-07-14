/**
 * RED tests — stopReason / errorMessage propagation into HookContext.task.result.
 *
 * CURRENT behavior (src/hooks/trigger-wiring.ts):
 *   - onSubagentStop(SubagentStopLike) builds a HookContext with NO task field
 *     → stopReason is silently discarded.
 *   - onSpawnCompleted(SubagentStopLike) builds a HookContext with NO task field
 *     → stopReason is silently discarded.
 *   - onSessionRemoved(session, { error:true, errorMessage }) builds a
 *     HookContext with NO task field → errorMessage is silently discarded.
 *
 * DESIRED behavior: each of these callbacks forwards its reason/error message
 * into the HookContext.task.result field so downstream consumers
 * (WakeSubscriber.formatWakeMessage) can surface it in the wake message.
 *
 * These tests drive HookTriggerManager callbacks directly and capture the
 * HookContext passed to dispatcher.fire. They MUST FAIL until the GREEN
 * worker adds a `task: { ..., result }` block to each callback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { HookTriggerManager } from "../../src/hooks/trigger-wiring.js";
import type { HookContext } from "../../src/hooks/types.js";

function createMockDispatcher() {
	const fire = vi.fn().mockResolvedValue(undefined);
	return { fire };
}

describe("trigger-wiring result propagation — RED", () => {
	let dispatcher: ReturnType<typeof createMockDispatcher>;
	let manager: HookTriggerManager;

	beforeEach(() => {
		dispatcher = createMockDispatcher();
		manager = new HookTriggerManager({
			hookDispatcher: dispatcher,
			defaultAgentType: "acp",
			defaultCwd: "/tmp/project",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Extract the HookContext from the most recent dispatcher.fire call. */
	function lastContext(): HookContext {
		expect(dispatcher.fire).toHaveBeenCalled();
		const call = dispatcher.fire.mock.calls[dispatcher.fire.mock.calls.length - 1];
		// call = [eventName, context]
		return call[1] as HookContext;
	}

	// ── onSubagentStop → subagent_stop ───────────────────────────────────────
	describe("onSubagentStop (subagent_stop)", () => {
		it("forwards stopReason into context.task.result", async () => {
			await manager.onSubagentStop({
				sessionId: "sess-stop-1",
				agentName: "coder",
				stopReason: "end_turn",
				cwd: "/repo",
			});

			const ctx = lastContext();
			expect(ctx.event).toBe("subagent_stop");
			expect(ctx.task).toBeDefined();
			expect(ctx.task?.result).toBe("end_turn");
		});

		it("forwards a long stopReason message into context.task.result", async () => {
			const reason = "max_tokens — output truncated at 4096 tokens";
			await manager.onSubagentStop({
				sessionId: "sess-stop-2",
				agentName: "researcher",
				stopReason: reason,
			});

			const ctx = lastContext();
			expect(ctx.task?.result).toBe(reason);
		});
	});

	// ── onSpawnCompleted → spawn_completed ───────────────────────────────────
	describe("onSpawnCompleted (spawn_completed)", () => {
		it("forwards stopReason into context.task.result", async () => {
			await manager.onSpawnCompleted({
				sessionId: "sess-spawn-1",
				agentName: "browser-tester",
				stopReason: "background suite finished cleanly",
				cwd: "/repo",
			});

			const ctx = lastContext();
			expect(ctx.event).toBe("spawn_completed");
			expect(ctx.task).toBeDefined();
			expect(ctx.task?.result).toBe("background suite finished cleanly");
		});
	});

	// ── onSessionRemoved (error) → session_failed ────────────────────────────
	describe("onSessionRemoved with error (session_failed)", () => {
		it("forwards errorMessage into context.task.result", async () => {
			await manager.onSessionRemoved(
				{
					id: "sess-fail-1",
					agent: "coder",
					cwd: "/repo",
				},
				{
					error: true,
					errorMessage: "agent crashed: OOM kill",
				},
			);

			const ctx = lastContext();
			expect(ctx.event).toBe("session_failed");
			expect(ctx.task).toBeDefined();
			expect(ctx.task?.result).toBe("agent crashed: OOM kill");
		});

		it("forwards an empty/error-without-message case gracefully (task present)", async () => {
			// error:true but no errorMessage — task.result should still be a
			// string (possibly empty/placeholder), not undefined task entirely.
			await manager.onSessionRemoved(
				{ id: "sess-fail-2", agent: "coder", cwd: "/repo" },
				{ error: true },
			);

			const ctx = lastContext();
			expect(ctx.task).toBeDefined();
			expect(typeof ctx.task?.result).toBe("string");
		});
	});
});

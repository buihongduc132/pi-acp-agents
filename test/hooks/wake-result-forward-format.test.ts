/**
 * RED tests — result-forwarding in wake message formatting.
 *
 * CURRENT behavior (src/hooks/wake-subscriber.ts → formatWakeMessage):
 *   `task.result` is appended to the formatted content ONLY when the
 *   event-type includes "failed" or "error".
 *
 * DESIRED behavior: result text is surfaced for ALL completion/stop events
 * where a result is present — i.e.:
 *   - task_completed   (currently DROPPED — RED)
 *   - session_completed (when task.result present — currently DROPPED — RED)
 *   - spawn_completed   (currently DROPPED — RED)
 *   - subagent_stop     (when task.result present — currently DROPPED — RED)
 *
 * `formatWakeMessage` is a private (non-exported) function, so these tests
 * drive it through the public WakeSubscriber.handleEvent() entry point and
 * assert on the `content` (1st arg) passed to pi.sendMessage.
 *
 * Muting is disabled (mutedEventTypes: []) and coalescing is disabled
 * (coalesceWindowMs: 0) so every event reaches the format path.
 *
 * These tests MUST FAIL until the GREEN worker relaxes the
 * `failed`/`error`-only condition in formatWakeMessage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketEvent } from "../../src/hooks/types.js";

function createMockPi() {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		isIdle: vi.fn().mockReturnValue(true),
		log: vi.fn(),
	};
}

/**
 * Build a SocketEvent with a fully-formed HookContext payload.
 * Defaults yield a non-muted, completion-style event with a task result.
 */
function makeEvent(
	eventType: string,
	eventId: string,
	overrides: {
		agentName?: string;
		subject?: string;
		result?: string;
		durationMs?: number;
		taskStatus?: string;
		cwd?: string;
	} = {},
): SocketEvent {
	const {
		agentName = "verifier",
		subject = "Implement feature X",
		result,
		durationMs,
		taskStatus = "completed",
		cwd = "/tmp/project",
	} = overrides;

	return {
		"event-type": eventType,
		"event-id": eventId,
		timestamp: new Date().toISOString(),
		source: "acp",
		payload: {
			version: 1,
			event: eventType.replace(/^acp\./, "") as any,
			source: "acp",
			correlationId: `corr-${eventId}`,
			session: { id: "sess-1", agent: agentName, cwd },
			agent: { name: agentName, type: "coding" },
			task: {
				id: "task-123",
				subject,
				status: taskStatus,
				...(durationMs !== undefined ? { durationMs } : {}),
				...(result !== undefined ? { result } : {}),
			},
			timestamp: new Date().toISOString(),
		},
	};
}

describe("wake result-forwarding (formatWakeMessage) — RED", () => {
	let tmpDir: string;
	let sockPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-wake-fwd-"));
		sockPath = join(tmpDir, "events.sock");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/**
	 * Helper: instantiate a fresh WakeSubscriber with muting + coalescing
	 * disabled so every event reaches the format path.
	 */
	function makeWake() {
		const pi = createMockPi();
		const wake = new WakeSubscriber({
			path: sockPath,
			pi,
			mutedEventTypes: [],
			coalesceWindowMs: 0,
		} as any);
		return { pi, wake };
	}

	// ── task_completed ───────────────────────────────────────────────────────
	describe("task_completed", () => {
		it("surfaces task.result text in formatted content (currently dropped)", async () => {
			const { pi, wake } = makeWake();

			const event = makeEvent("acp.task_completed", "evt-tc-1", {
				result: "All 42 tests passed",
			});
			await wake.handleEvent(event);

			expect(pi.sendMessage).toHaveBeenCalledTimes(1);
			const content: string = pi.sendMessage.mock.calls[0][0];
			// DESIRED: result text appears in the wake message.
			expect(content).toContain("All 42 tests passed");
		});

		it("surfaces task.result with the dash separator (currently dropped)", async () => {
			const { pi, wake } = makeWake();

			const event = makeEvent("acp.task_completed", "evt-tc-2", {
				result: "shipped v1.2.3",
			});
			await wake.handleEvent(event);

			const content: string = pi.sendMessage.mock.calls[0][0];
			// DESIRED: result is appended after a dash separator, mirroring the
			// existing session_failed behavior.
			expect(content).toContain("— shipped v1.2.3");
		});
	});

	// ── session_completed (with result) ──────────────────────────────────────
	describe("session_completed with result", () => {
		it("surfaces task.result text in formatted content (currently dropped)", async () => {
			const { pi, wake } = makeWake();

			const event = makeEvent("acp.session_completed", "evt-sc-1", {
				result: "session output summary text",
			});
			await wake.handleEvent(event);

			const content: string = pi.sendMessage.mock.calls[0][0];
			expect(content).toContain("session output summary text");
		});
	});

	// ── spawn_completed ──────────────────────────────────────────────────────
	describe("spawn_completed", () => {
		it("surfaces task.result (carrying stopReason) in formatted content (currently dropped)", async () => {
			const { pi, wake } = makeWake();

			const event = makeEvent("acp.spawn_completed", "evt-sp-1", {
				agentName: "browser-tester",
				subject: "E2E suite",
				result: "end turn — suite finished cleanly",
			});
			await wake.handleEvent(event);

			const content: string = pi.sendMessage.mock.calls[0][0];
			expect(content).toContain("end turn — suite finished cleanly");
		});
	});

	// ── subagent_stop ────────────────────────────────────────────────────────
	describe("subagent_stop", () => {
		it("surfaces task.result (carrying stopReason) in formatted content (currently dropped)", async () => {
			const { pi, wake } = makeWake();

			// subagent_stop is muted by DEFAULT, but we disabled muting above
			// to isolate the format-layer behavior.
			const event = makeEvent("acp.subagent_stop", "evt-sa-1", {
				agentName: "coder",
				subject: "Fix bug #7",
				result: "end turn — diff applied",
			});
			await wake.handleEvent(event);

			expect(pi.sendMessage).toHaveBeenCalledTimes(1);
			const content: string = pi.sendMessage.mock.calls[0][0];
			expect(content).toContain("end turn — diff applied");
		});
	});

});

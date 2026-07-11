/**
 * RED TESTS — Wake Event Filtering (OT27, OT28) + Correlation Grouping (OT29)
 *
 * These tests document what's BROKEN and what needs to be fixed.
 * Every test here should FAIL until the source is patched.
 *
 * Fix summary:
 *   OT27: session_started events are MUTED (not delivered) by default for
 *         transient subagent types. Configurable via `mutedEventTypes` option.
 *         Default muted: ['acp.session_started', 'acp.subagent_stop']
 *   OT28: subagent_stop events are DROPPED (not delivered) — redundant with
 *         session_completed/session_failed. Included in default muted list.
 *   OT29: Events sharing the same correlationId within a coalesce window
 *         (default 200ms) are grouped into a single summary message.
 *         E.g., 3 session_failed with same correlationId → one message:
 *         '[acp:system] 3 sessions failed in task X'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketEvent } from "../../src/hooks/types.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let eventCounter = 0;

function makeEvent(
	eventType: string,
	correlationId: string = "corr-1",
	taskId?: string,
): SocketEvent {
	eventCounter++;
	return {
		"event-type": eventType,
		"event-id": `evt-${eventCounter}`,
		timestamp: new Date().toISOString(),
		source: "acp",
		payload: {
			version: 1,
			event: "session_started",
			source: "acp",
			correlationId,
			session: { id: "sess-1", agent: "test-agent", cwd: "/tmp" },
			agent: { name: "test-agent", type: "transient" },
			task: taskId
				? { id: taskId, subject: "Test task", status: "in_progress" }
				: undefined,
			timestamp: new Date().toISOString(),
		},
	};
}

function createMockPi() {
	const sentMessages: string[] = [];
	return {
		sentMessages,
		sendMessage: vi.fn(async (message: string) => {
			sentMessages.push(message);
		}),
		isIdle: vi.fn(() => true),
		log: vi.fn(),
	};
}

function createSubscriber(
	overrides: Record<string, unknown> = {},
): { subscriber: WakeSubscriber; pi: ReturnType<typeof createMockPi> } {
	const pi = createMockPi();
	const subscriber = new WakeSubscriber({
		path: "/tmp/test.sock",
		pi,
		minIntervalMs: 0, // disable rate limiting for tests
		...overrides,
	} as any);
	return { subscriber, pi };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OT27: session_started events are MUTED by default
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] OT27: session_started events should be muted by default", () => {
	beforeEach(() => {
		eventCounter = 0;
	});

	it("session_started event should NOT be delivered (muted by default)", async () => {
		const { subscriber, pi } = createSubscriber();

		const event = makeEvent("acp.session_started");
		await subscriber.handleEvent(event);

		// FIX: WakeSubscriber should have a default mutedEventTypes that includes
		// 'acp.session_started'. Currently all acp.* events are delivered.
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("session_completed IS delivered (not in muted list)", async () => {
		const { subscriber, pi } = createSubscriber();

		const event = makeEvent("acp.session_completed");
		await subscriber.handleEvent(event);

		// session_completed is a NEVER_DROP event and should always be delivered
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("session_failed IS delivered (not in muted list)", async () => {
		const { subscriber, pi } = createSubscriber();

		const event = makeEvent("acp.session_failed");
		await subscriber.handleEvent(event);

		// session_failed is a NEVER_DROP event and should always be delivered
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OT28: subagent_stop events are DROPPED by default
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] OT28: subagent_stop events should be dropped by default", () => {
	beforeEach(() => {
		eventCounter = 0;
	});

	it("subagent_stop event should NOT be delivered (muted by default)", async () => {
		const { subscriber, pi } = createSubscriber();

		const event = makeEvent("acp.subagent_stop");
		await subscriber.handleEvent(event);

		// FIX: WakeSubscriber should have a default mutedEventTypes that includes
		// 'acp.subagent_stop'. Currently all acp.* events are delivered.
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("task_completed IS delivered (not in muted list)", async () => {
		const { subscriber, pi } = createSubscriber();

		const event = makeEvent("acp.task_completed");
		await subscriber.handleEvent(event);

		// task_completed is a NEVER_DROP event and should always be delivered
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OT27/OT28: Custom mutedEventTypes configuration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] OT27/OT28: mutedEventTypes option should override defaults", () => {
	beforeEach(() => {
		eventCounter = 0;
	});

	it("custom mutedEventTypes overrides defaults", async () => {
		// FIX: WakeSubscriberOptions should accept mutedEventTypes
		const { subscriber, pi } = createSubscriber({
			mutedEventTypes: ["acp.session_idle"],
		});

		// session_started should now be delivered (not in custom muted list)
		const startedEvent = makeEvent("acp.session_started");
		await subscriber.handleEvent(startedEvent);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// session_idle should be muted (in custom muted list)
		pi.sendMessage.mockClear();
		const idleEvent = makeEvent("acp.session_idle");
		await subscriber.handleEvent(idleEvent);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("empty mutedEventTypes means no muting (all events delivered)", async () => {
		// FIX: WakeSubscriberOptions should accept mutedEventTypes: []
		const { subscriber, pi } = createSubscriber({
			mutedEventTypes: [],
		});

		// session_started should be delivered (empty muted list = no muting)
		const startedEvent = makeEvent("acp.session_started");
		await subscriber.handleEvent(startedEvent);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// subagent_stop should also be delivered
		pi.sendMessage.mockClear();
		const stopEvent = makeEvent("acp.subagent_stop");
		await subscriber.handleEvent(stopEvent);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OT29: Correlation-based coalescing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] OT29: Events with same correlationId should be coalesced", () => {
	beforeEach(() => {
		eventCounter = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("3 events with same correlationId within 200ms → 1 coalesced delivery", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		// FIX: WakeSubscriber should accept coalesceWindowMs option
		// and group events sharing the same correlationId within that window

		const event1 = makeEvent("acp.session_failed", "corr-abc", "task-1");
		const event2 = makeEvent("acp.session_failed", "corr-abc", "task-1");
		const event3 = makeEvent("acp.session_failed", "corr-abc", "task-1");

		// Fire all 3 events within the coalesce window
		await subscriber.handleEvent(event1);
		await subscriber.handleEvent(event2);
		await subscriber.handleEvent(event3);

		// Advance past the coalesce window to trigger flush
		await vi.advanceTimersByTimeAsync(250);

		// FIX: Should produce exactly 1 coalesced message, not 3 separate ones
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// The coalesced message should mention the count
		const message = pi.sentMessages[0];
		expect(message).toMatch(/3/);
	});

	it("coalesced message mentions count ('3 sessions failed')", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		const event1 = makeEvent("acp.session_failed", "corr-xyz", "task-2");
		const event2 = makeEvent("acp.session_failed", "corr-xyz", "task-2");
		const event3 = makeEvent("acp.session_failed", "corr-xyz", "task-2");

		await subscriber.handleEvent(event1);
		await subscriber.handleEvent(event2);
		await subscriber.handleEvent(event3);

		await vi.advanceTimersByTimeAsync(250);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		// FIX: Message format should be like '[acp:system] 3 sessions failed in task task-2'
		const message = pi.sentMessages[0];
		expect(message).toMatch(/3\s+session(s)?\s+failed/);
	});

	it("events with different correlationId → separate deliveries", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		const event1 = makeEvent("acp.session_failed", "corr-aaa");
		const event2 = makeEvent("acp.session_failed", "corr-bbb");
		const event3 = makeEvent("acp.session_failed", "corr-ccc");

		await subscriber.handleEvent(event1);
		await subscriber.handleEvent(event2);
		await subscriber.handleEvent(event3);

		await vi.advanceTimersByTimeAsync(250);

		// FIX: Different correlationIds should NOT be coalesced
		expect(pi.sendMessage).toHaveBeenCalledTimes(3);
	});

	it("coalesce window expiry → events delivered separately", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		const event1 = makeEvent("acp.session_failed", "corr-time");
		await subscriber.handleEvent(event1);

		// Wait past the coalesce window
		await vi.advanceTimersByTimeAsync(250);

		const event2 = makeEvent("acp.session_failed", "corr-time");
		await subscriber.handleEvent(event2);

		await vi.advanceTimersByTimeAsync(250);

		// FIX: Events separated by more than coalesceWindowMs should be
		// delivered as separate messages
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("NEVER_DROP events participate in coalescing (not dropped)", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		// session_completed and session_failed are NEVER_DROP events
		// They should participate in coalescing but never be dropped
		const event1 = makeEvent("acp.session_completed", "corr-nd");
		const event2 = makeEvent("acp.session_completed", "corr-nd");

		await subscriber.handleEvent(event1);
		await subscriber.handleEvent(event2);

		await vi.advanceTimersByTimeAsync(250);

		// FIX: NEVER_DROP events should still be coalesced (grouped)
		// but the group should always be delivered
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("mixed event types with same correlationId → grouped", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		const event1 = makeEvent("acp.session_failed", "corr-mixed", "task-m");
		const event2 = makeEvent("acp.session_completed", "corr-mixed", "task-m");
		const event3 = makeEvent("acp.session_failed", "corr-mixed", "task-m");

		await subscriber.handleEvent(event1);
		await subscriber.handleEvent(event2);
		await subscriber.handleEvent(event3);

		await vi.advanceTimersByTimeAsync(250);

		// FIX: All events sharing correlationId within window should be
		// grouped into a single summary message
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OT29: coalesceWindowMs configuration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] OT29: coalesceWindowMs should be configurable", () => {
	beforeEach(() => {
		eventCounter = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("default coalesceWindowMs should be 200", async () => {
		// FIX: WakeSubscriberOptions should have coalesceWindowMs defaulting to 200
		const { subscriber, pi } = createSubscriber();

		const event1 = makeEvent("acp.session_failed", "corr-default");
		const event2 = makeEvent("acp.session_failed", "corr-default");

		await subscriber.handleEvent(event1);
		await subscriber.handleEvent(event2);

		// At 150ms (within 200ms default window), should still be coalescing
		await vi.advanceTimersByTimeAsync(150);

		// At 250ms total (past 200ms default window), should have flushed
		await vi.advanceTimersByTimeAsync(100);

		// FIX: With default 200ms window, 2 events within window → 1 delivery
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("custom coalesceWindowMs of 500ms extends the window", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 500,
		});

		const event1 = makeEvent("acp.session_failed", "corr-500");
		await subscriber.handleEvent(event1);

		// At 200ms — still within 500ms window
		await vi.advanceTimersByTimeAsync(200);

		const event2 = makeEvent("acp.session_failed", "corr-500");
		await subscriber.handleEvent(event2);

		// At 400ms total — still within 500ms window from first event
		await vi.advanceTimersByTimeAsync(200);

		// FIX: Both events should be coalesced into 1 delivery
		// Timer resets on second event at t=200ms, so fires at t=700ms
		// Need to advance 300ms more to reach t=700ms
		await vi.advanceTimersByTimeAsync(300);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Integration: muting + coalescing together
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("[RED] Integration: muting and coalescing work together", () => {
	beforeEach(() => {
		eventCounter = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("muted events are not coalesced or delivered", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		// session_started is muted by default
		const startedEvent = makeEvent("acp.session_started", "corr-mute-coal");
		await subscriber.handleEvent(startedEvent);

		// subagent_stop is muted by default
		const stopEvent = makeEvent("acp.subagent_stop", "corr-mute-coal");
		await subscriber.handleEvent(stopEvent);

		await vi.advanceTimersByTimeAsync(250);

		// FIX: Muted events should not produce any delivery at all
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("non-muted events are coalesced even when muted events arrive", async () => {
		const { subscriber, pi } = createSubscriber({
			coalesceWindowMs: 200,
		});

		// Mix of muted and non-muted events with same correlationId
		const startedEvent = makeEvent("acp.session_started", "corr-mix");
		const failedEvent1 = makeEvent("acp.session_failed", "corr-mix", "task-x");
		const stopEvent = makeEvent("acp.subagent_stop", "corr-mix");
		const failedEvent2 = makeEvent("acp.session_failed", "corr-mix", "task-x");

		await subscriber.handleEvent(startedEvent);
		await subscriber.handleEvent(failedEvent1);
		await subscriber.handleEvent(stopEvent);
		await subscriber.handleEvent(failedEvent2);

		await vi.advanceTimersByTimeAsync(250);

		// FIX: Only the 2 session_failed events should be coalesced into 1 delivery
		// session_started and subagent_stop are muted
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = pi.sentMessages[0];
		expect(message).toMatch(/2/);
	});
});

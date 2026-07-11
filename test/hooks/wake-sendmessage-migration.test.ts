/**
 * RED tests for WakeSubscriber sendMessage migration + queue+flush pattern.
 *
 * These tests assert the TARGET state (post-migration) and MUST FAIL against
 * the current source code which uses `pi.sendUserMessage(message, {deliverAs:'followUp'})`.
 *
 * Target requirements:
 * - LD1:  sendMessage(content, {customType, display, details}, {triggerTurn|deliverAs})
 * - LD2:  Queue+flush — when isIdle()=false, buffer; when idle, flush with triggerTurn:true
 * - OT9:  turnInFlight flag prevents TOCTOU race — 2nd event during in-flight → followUp
 * - OT11: reconnect() ALWAYS uses deliverAs:'followUp' regardless of idle state
 * - OT12: pi adapter has isIdle(): boolean
 * - OT18: sendMessage for triggerTurn is fire-and-forget (no await)
 * - OT25: session_failed events throttled at 200ms
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketEvent } from "../../src/hooks/types.js";

// ── Target interfaces (post-migration) ──────────────────────────────────────

interface AcpWakeDetails {
  eventType: string;
  eventId: string;
  correlationId: string;
  agentName: string;
  cwd: string;
  task?: { id: string; subject: string };
}

interface SendMessageOptions {
  customType: string;
  display: boolean;
  details: AcpWakeDetails;
}

interface SendMessageDelivery {
  triggerTurn?: boolean;
  deliverAs?: "followUp";
}

interface TargetPiAdapter {
  sendMessage: (
    content: string,
    options: SendMessageOptions,
    delivery: SendMessageDelivery,
  ) => Promise<void> | void;
  isIdle: () => boolean;
  log?: (...args: unknown[]) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockPi(idle = true): {
  pi: TargetPiAdapter;
  sendMessage: ReturnType<typeof vi.fn>;
  isIdle: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const isIdle = vi.fn().mockReturnValue(idle);
  const log = vi.fn();
  return {
    pi: { sendMessage, isIdle, log },
    sendMessage,
    isIdle,
    log,
  };
}

function makeEvent(
  eventType: string,
  eventId: string,
  overrides: Partial<SocketEvent> = {},
): SocketEvent {
  return {
    "event-type": eventType,
    "event-id": eventId,
    timestamp: new Date().toISOString(),
    source: "acp",
    payload: {
      version: 1,
      event: "task_completed",
      source: "acp",
      correlationId: `corr-${eventId}`,
      session: { id: "sess-1", agent: "pi", cwd: "/tmp/test" },
      agent: { name: "pi", type: "coding" },
      task: { id: "t-1", subject: "test task", status: "completed" },
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("wake-subscriber sendMessage migration", () => {
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-wake-migration-"));
    sockPath = join(tmpDir, "events.sock");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── LD1: sendMessage with correct signature ─────────────────────────────

  describe("LD1 — sendMessage replaces sendUserMessage", () => {
    it("calls pi.sendMessage (not sendUserMessage) with customType 'acp_wake'", async () => {
      const { pi, sendMessage } = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      const event = makeEvent("acp.task_completed", "evt-1");
      await wake.handleEvent(event);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [content, options, delivery] = sendMessage.mock.calls[0];

      // content is a string containing event info
      expect(typeof content).toBe("string");

      // options.customType must be 'acp_wake'
      expect(options.customType).toBe("acp_wake");

      // options.display must be true
      expect(options.display).toBe(true);

      // options.details must contain event metadata
      expect(options.details).toBeDefined();
      expect(options.details.eventType).toBe("acp.task_completed");
      expect(options.details.eventId).toBe("evt-1");
      expect(options.details.correlationId).toBe("corr-evt-1");
      expect(options.details.agentName).toBe("pi");
      expect(options.details.cwd).toBe("/tmp/test");
    });

    it("includes task details in AcpWakeDetails when task is present", async () => {
      const { pi, sendMessage } = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      const event = makeEvent("acp.task_completed", "evt-task");
      await wake.handleEvent(event);

      const [, options] = sendMessage.mock.calls[0];
      expect(options.details.task).toEqual({
        id: "t-1",
        subject: "test task",
      });
    });

    it("does NOT call sendUserMessage (old API)", async () => {
      const { pi, sendMessage } = createMockPi();
      // Attach a sendUserMessage spy to verify it's NOT called
      const sendUserMessage = vi.fn();
      (pi as any).sendUserMessage = sendUserMessage;

      const wake = new WakeSubscriber({ path: sockPath, pi } as any);
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-old"));

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── LD2: Queue+flush pattern ────────────────────────────────────────────

  describe("LD2 — queue+flush when agent busy", () => {
    it("uses triggerTurn:true when isIdle()=true", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(true);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-idle"));

      expect(isIdle).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = sendMessage.mock.calls[0];
      expect(delivery.triggerTurn).toBe(true);
    });

    it("buffers event locally when isIdle()=false (agent busy)", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(false);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-busy"));

      // LD2: When agent is busy, event should be buffered locally (not sent)
      expect(sendMessage).not.toHaveBeenCalled();

      // When agent becomes idle and flush is called, event should be sent with triggerTurn
      isIdle.mockReturnValue(true);
      await wake.flush();

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = sendMessage.mock.calls[0];
      expect(delivery.triggerTurn).toBe(true);
    });

    it("flushes buffered events with triggerTurn:true when agent becomes idle", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(false);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      // Buffer some events while busy
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-buf-1"));
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-buf-2"));

      sendMessage.mockClear();

      // Now agent becomes idle — simulate flush trigger
      isIdle.mockReturnValue(true);

      // If there's a flush method, call it; otherwise handleEvent with idle
      // should flush. The implementation should expose a way to flush.
      if (typeof (wake as any).flush === "function") {
        await (wake as any).flush();
      } else {
        // Fallback: send another event which should trigger flush
        await wake.handleEvent(makeEvent("acp.task_completed", "evt-flush"));
      }

      // At least one flushed event must have been sent with triggerTurn:true
      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
      const flushedWithTriggerTurn = sendMessage.mock.calls.some((call: any[]) => {
        const [, , delivery] = call;
        return delivery.triggerTurn === true;
      });
      expect(flushedWithTriggerTurn).toBe(true);
    });
  });

  // ── OT9: turnInFlight TOCTOU guard ──────────────────────────────────────

  describe("OT9 — turnInFlight prevents TOCTOU race", () => {
    it("second event during in-flight triggerTurn falls back to deliverAs:followUp", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(true);

      // Make sendMessage async and slow so we can send a 2nd event during flight
      let resolveFirst: () => void;
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      sendMessage.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            // Don't resolve immediately — simulate in-flight
            resolveFirst = resolve;
          }),
      );

      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      // First event — triggers triggerTurn (isIdle=true), but sendMessage is pending
      const firstPromise = wake.handleEvent(
        makeEvent("acp.task_completed", "evt-first"),
      );

      // Second event arrives while first is still in-flight
      // Even though isIdle()=true, turnInFlight should force followUp
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-second"));

      // Both calls should have happened
      expect(sendMessage.mock.calls.length).toBe(2);

      // The second call should use deliverAs:'followUp', NOT triggerTurn
      const [, , secondDelivery] = sendMessage.mock.calls[1];
      expect(secondDelivery.deliverAs).toBe("followUp");
      expect(secondDelivery.triggerTurn).toBeFalsy();

      // Resolve the first call
      resolveFirst!();
      await firstPromise;
    });

    it("turnInFlight flag is cleared after sendMessage completes", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(true);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      // First event completes normally
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-done"));

      sendMessage.mockClear();

      // Second event should again get triggerTurn (flag was cleared)
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-after"));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = sendMessage.mock.calls[0];
      expect(delivery.triggerTurn).toBe(true);
    });
  });

  // ── OT11: reconnect() always uses deliverAs:'followUp' ──────────────────

  describe("OT11 — reconnect replay always uses deliverAs:followUp", () => {
    it("replay uses deliverAs:'followUp' even when isIdle()=true", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(true);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      // Buffer some events
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-rep-1"));
      await wake.handleEvent(makeEvent("acp.session_started", "evt-rep-2"));

      sendMessage.mockClear();

      // Reconnect replay — must ALWAYS use deliverAs:'followUp'
      await wake.reconnect();

      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
      for (const call of sendMessage.mock.calls) {
        const [, , delivery] = call;
        expect(delivery.deliverAs).toBe("followUp");
        expect(delivery.triggerTurn).toBeFalsy();
      }
    });

    it("replay uses deliverAs:'followUp' even when isIdle()=false", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(false);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-rep-busy"));
      sendMessage.mockClear();

      await wake.reconnect();

      // Replay must produce at least one sendMessage call
      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
      for (const call of sendMessage.mock.calls) {
        const [, , delivery] = call;
        expect(delivery.deliverAs).toBe("followUp");
        expect(delivery.triggerTurn).toBeFalsy();
      }
    });
  });

  // ── OT12: pi adapter has isIdle() ───────────────────────────────────────

  describe("OT12 — pi adapter exposes isIdle()", () => {
    it("calls pi.isIdle() to determine delivery strategy", async () => {
      const { pi, isIdle } = createMockPi(true);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-isidle"));

      expect(isIdle).toHaveBeenCalled();
    });

    it("constructor accepts pi with isIdle method", () => {
      const { pi } = createMockPi();
      // This should not throw — the constructor must accept the new interface
      expect(() => {
        new WakeSubscriber({ path: sockPath, pi } as any);
      }).not.toThrow();
    });
  });

  // ── OT18: fire-and-forget triggerTurn ───────────────────────────────────

  describe("OT18 — triggerTurn is fire-and-forget (no await)", () => {
    it("does not await sendMessage when using triggerTurn", async () => {
      const { pi, sendMessage } = createMockPi(true);

      let sendResolved = false;
      sendMessage.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              sendResolved = true;
              resolve();
            }, 100);
          }),
      );

      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      // handleEvent should return quickly even though sendMessage is slow
      const start = Date.now();
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-fire"));
      const elapsed = Date.now() - start;

      // If fire-and-forget, handleEvent returns well before sendMessage resolves
      // We allow some margin but it should be < 50ms (not 100ms+)
      expect(elapsed).toBeLessThan(80);

      // Eventually the send resolves
      await new Promise((r) => setTimeout(r, 150));
      expect(sendResolved).toBe(true);
    });

    it("errors from triggerTurn sendMessage are caught and logged", async () => {
      const { pi, sendMessage, log } = createMockPi(true);

      sendMessage.mockRejectedValue(new Error("triggerTurn exploded"));

      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      // Should not throw — fire-and-forget with error isolation
      await expect(
        wake.handleEvent(makeEvent("acp.task_completed", "evt-err")),
      ).resolves.not.toThrow();

      // sendMessage must have been called (proves it's using new API)
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Error should be logged
      expect(log).toHaveBeenCalled();
      expect(wake.isAlive()).toBe(true);
    });
  });

  // ── OT25: session_failed throttle at 200ms ──────────────────────────────

  describe("OT25 — session_failed throttled at 200ms", () => {
    it("first session_failed event is delivered", async () => {
      const { pi, sendMessage } = createMockPi(true);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      await wake.handleEvent(
        makeEvent("acp.session_failed", "evt-fail-1"),
      );

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("second session_failed within 200ms is throttled (dropped or followUp)", async () => {
      const { pi, sendMessage } = createMockPi(true);
      const wake = new WakeSubscriber({
        path: sockPath,
        pi,
        minIntervalMs: 200,
      } as any);

      // First session_failed
      await wake.handleEvent(
        makeEvent("acp.session_failed", "evt-fail-1"),
      );
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Second session_failed immediately after (< 200ms)
      await wake.handleEvent(
        makeEvent("acp.session_failed", "evt-fail-2"),
      );

      // The second event should be throttled — either not sent at all
      // or sent as followUp (not triggerTurn)
      // In the target state, session_failed is throttled at 200ms
      // so the 2nd call within 200ms should be dropped
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("session_failed after 200ms throttle window is delivered", async () => {
      const { pi, sendMessage } = createMockPi(true);
      const wake = new WakeSubscriber({
        path: sockPath,
        pi,
        minIntervalMs: 200,
      } as any);

      // First session_failed
      await wake.handleEvent(
        makeEvent("acp.session_failed", "evt-fail-a"),
      );
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Wait past throttle window
      await new Promise((r) => setTimeout(r, 250));

      // Second session_failed — should be delivered now
      await wake.handleEvent(
        makeEvent("acp.session_failed", "evt-fail-b"),
      );
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ── Integration: full queue+flush lifecycle ─────────────────────────────

  describe("integration — queue+flush lifecycle", () => {
    it("events during busy period are flushed as triggerTurn when idle resumes", async () => {
      const { pi, sendMessage, isIdle } = createMockPi(false);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      // 3 events while busy (all non-muted)
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-q1"));
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-q2"));
      await wake.handleEvent(makeEvent("acp.task_failed", "evt-q3"));

      // While busy, events should be buffered locally (not sent)
      expect(sendMessage).not.toHaveBeenCalled();

      // Agent becomes idle
      isIdle.mockReturnValue(true);

      // Flush should send all buffered events with triggerTurn:true
      await wake.flush();

      expect(sendMessage).toHaveBeenCalledTimes(3);
      for (const call of sendMessage.mock.calls) {
        const [, , delivery] = call;
        expect(delivery.triggerTurn).toBe(true);
      }
    });

    it("mixed event types produce correct sendMessage calls", async () => {
      const { pi, sendMessage } = createMockPi(true);
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      const events = [
        makeEvent("acp.task_completed", "e1"),
        makeEvent("acp.task_completed", "e2"),
        makeEvent("acp.session_failed", "e3"),
      ];

      for (const evt of events) {
        await wake.handleEvent(evt);
      }

      // Must use sendMessage (not sendUserMessage) for all events
      expect(sendMessage.mock.calls.length).toBe(3);

      // Each call should have customType:'acp_wake' and display:true
      for (const call of sendMessage.mock.calls) {
        const [, options] = call;
        expect(options.customType).toBe("acp_wake");
        expect(options.display).toBe(true);
      }
    });
  });
});

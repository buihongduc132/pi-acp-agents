/**
 * RED tests for src/hooks/wake-subscriber.ts — WakeSubscriber
 *
 * Source does NOT exist yet. These tests MUST FAIL (RED phase of TDD).
 * Spec: flow/plans/acp-hooks-impl-spec.md
 *
 * WakeSubscriber connects to the socket bus and delivers events to pi
 * via pi.sendUserMessage(msg, { deliverAs: "followUp" }) — LD16.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Source modules do not exist yet — import will fail (RED)
import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketEvent } from "../../src/hooks/types.js";

/**
 * Creates a mock pi context with a spied sendUserMessage.
 */
function createMockPi() {
  return {
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    ui: { setStatus: vi.fn() },
  };
}

function makeEvent(
  eventType: string,
  eventId: string,
  overrides: Partial<SocketEvent> = {}
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
      session: { id: "sess-1", agent: "pi", cwd: "/tmp" },
      agent: { name: "pi", type: "coding" },
      task: { id: "t-1", subject: "test", status: "completed" },
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe("wake-subscriber", () => {
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-wake-"));
    sockPath = join(tmpDir, "events.sock");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── LD16: deliverAs:"followUp" ─────────────────────────────────────────
  describe("LD16 — deliverAs:followUp", () => {
    it("ALWAYS uses sendUserMessage with deliverAs:'followUp' option", async () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi });

      const event = makeEvent("acp.task_completed", "evt-1");
      await wake.handleEvent(event);

      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      const call = pi.sendUserMessage.mock.calls[0];
      const message = call[0];
      const options = call[1];
      expect(typeof message).toBe("string");
      expect(message).toContain("task_completed");
      expect(options).toEqual({ deliverAs: "followUp" });
    });

    it("never calls sendUserMessage without the deliverAs option", async () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi });

      const event = makeEvent("acp.session_started", "evt-2");
      await wake.handleEvent(event);

      for (const call of pi.sendUserMessage.mock.calls) {
        const opts = call[1];
        expect(opts).toBeDefined();
        expect(opts.deliverAs).toBe("followUp");
      }
    });

    it("does not use deliverAs:'reply' or other values", async () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi });

      const event = makeEvent("acp.task_failed", "evt-3");
      await wake.handleEvent(event);

      const opts = pi.sendUserMessage.mock.calls[0][1];
      expect(opts.deliverAs).not.toBe("reply");
      expect(opts.deliverAs).not.toBe("message");
      expect(opts.deliverAs).not.toBe("broadcast");
    });
  });

  // ── Event filtering ────────────────────────────────────────────────────
  describe("event filtering", () => {
    it("only processes events with event-type starting with 'acp.'", async () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi });

      // ACP event — should be processed
      await wake.handleEvent(makeEvent("acp.task_completed", "acp-1"));
      // Non-ACP event — should be skipped
      await wake.handleEvent(makeEvent("claude.pre_tool_use", "non-1"));
      await wake.handleEvent(makeEvent("codex.session_end", "non-2"));
      await wake.handleEvent(makeEvent("generic.event", "non-3"));

      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(pi.sendUserMessage.mock.calls[0][0]).toContain("task_completed");
    });

    it("ignores events without a recognized prefix", async () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi });

      await wake.handleEvent(makeEvent("no_prefix_event", "evt-x"));
      await wake.handleEvent(makeEvent("", "evt-empty"));

      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  // ── LD18: Reconnect replay ─────────────────────────────────────────────
  describe("LD18 — reconnect replay (ring buffer of 100)", () => {
    it("replays last 100 events on reconnect", async () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi });

      // Process 105 events
      for (let i = 0; i < 105; i++) {
        await wake.handleEvent(makeEvent("acp.task_completed", `evt-${i}`));
      }

      // Reset sendUserMessage to track only replayed events
      pi.sendUserMessage.mockClear();

      // Simulate reconnect
      await wake.reconnect();

      // Should replay the last 100 events
      expect(pi.sendUserMessage.mock.calls.length).toBe(100);
      // The first replayed event should be evt-5 (105 - 100 = 5 dropped)
      const firstReplayed = pi.sendUserMessage.mock.calls[0][0];
      expect(firstReplayed).toContain("evt-5");
    });

    it("does not exceed 100 entries in the ring buffer", async () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi });

      for (let i = 0; i < 250; i++) {
        await wake.handleEvent(makeEvent("acp.task_completed", `evt-${i}`));
      }

      const buffered = wake.getBufferedEvents();
      expect(buffered.length).toBe(100);
    });
  });

  // ── Intercom fallback ──────────────────────────────────────────────────
  describe("intercom fallback", () => {
    it("falls back to intercom after 3 socket failures", async () => {
      const pi = createMockPi();
      const intercomPublish = vi.fn().mockResolvedValue(undefined);
      const wake = new WakeSubscriber({
        path: "/nonexistent/invalid/path.sock",
        pi,
        intercom: { publish: intercomPublish },
        maxSocketRetries: 3,
        retryDelayMs: 10,
      });

      await wake.start();

      // After 3 failed attempts, intercom should be used
      await new Promise((r) => setTimeout(r, 200));

      expect(intercomPublish).toHaveBeenCalled();
      expect(wake.isUsingIntercom()).toBe(true);

      await wake.stop();
    });

    it("does not fall back to intercom if socket connects before 3 retries", async () => {
      const pi = createMockPi();
      const intercomPublish = vi.fn().mockResolvedValue(undefined);

      // Use a valid socket via a mock connector
      const wake = new WakeSubscriber({
        path: sockPath,
        pi,
        intercom: { publish: intercomPublish },
        maxSocketRetries: 3,
        retryDelayMs: 10,
        // Inject a connector that succeeds
        connector: async () => {
          return {
            on: vi.fn(),
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
          };
        },
      });

      await wake.start();
      await new Promise((r) => setTimeout(r, 100));

      expect(intercomPublish).not.toHaveBeenCalled();
      expect(wake.isUsingIntercom()).toBe(false);

      await wake.stop();
    });
  });

  // ── Error isolation ────────────────────────────────────────────────────
  describe("error isolation", () => {
    it("handler error does not crash the subscriber loop", async () => {
      const pi = createMockPi();
      // First call throws
      pi.sendUserMessage
        .mockRejectedValueOnce(new Error("pi down"))
        .mockResolvedValue(undefined);

      const wake = new WakeSubscriber({ path: sockPath, pi });

      // First event triggers error
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-err"));
      // Second event should still be processed (loop not crashed)
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-ok"));

      expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
      // Subscriber should still be alive
      expect(wake.isAlive()).toBe(true);

      await wake.stop();
    });

    it("catches and logs handler exceptions without propagating", async () => {
      const pi = createMockPi();
      pi.sendUserMessage.mockImplementation(() => {
        throw new Error("synchronous explosion");
      });

      const wake = new WakeSubscriber({ path: sockPath, pi });

      // Should not throw
      await expect(
        wake.handleEvent(makeEvent("acp.task_completed", "evt-sync-err"))
      ).resolves.not.toThrow();

      await wake.stop();
    });
  });
});

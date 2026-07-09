/**
 * RED tests — Rate Limiter for WakeSubscriber.
 *
 * Source does NOT implement rate limiting yet. These tests MUST FAIL (RED).
 * Spec: task #12 — throttle sendUserMessage calls so a burst of wake
 * events does not flood pi.
 *
 * WakeSubscriber gains a `minIntervalMs` option (default 1000ms). Events
 * arriving faster than the interval are coalesced/dropped. Completion events
 * (task_completed, session_completed, session_failed, task_failed) bypass
 * the limiter and are never throttled (SG3 — NEVER_DROP).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketEvent } from "../../src/hooks/types.js";

function createMockPi() {
  return {
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
}

function makeEvent(
  eventType: string,
  eventId: string,
  overrides: Partial<SocketEvent> = {}
): SocketEvent {
  // Strip leading "acp." so event-type matches the payload.event convention.
  const payloadEvent = eventType.replace(/^acp\./, "");
  return {
    "event-type": eventType,
    "event-id": eventId,
    timestamp: new Date().toISOString(),
    source: "acp",
    payload: {
      version: 1,
      event: payloadEvent as any,
      source: "acp",
      correlationId: `corr-${eventId}`,
      session: { id: "sess-1", agent: "pi", cwd: tmpdir() },
      agent: { name: "pi", type: "coding" },
      task: { id: `t-${eventId}`, subject: "test", status: "completed" },
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  };
}

const SOCK = join(tmpdir(), "acp-wake-rl.sock");

describe("wake-subscriber — rate limiter", () => {
  let pi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("first event always passes through immediately", async () => {
    const wake = new WakeSubscriber({
      path: SOCK,
      pi,
      minIntervalMs: 1000,
    });

    await wake.handleEvent(makeEvent("acp.subagent_start", "e-1"));

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("events arriving faster than minIntervalMs are dropped", async () => {
    const wake = new WakeSubscriber({
      path: SOCK,
      pi,
      minIntervalMs: 1000,
    });

    // Two events back-to-back, well under the interval
    await wake.handleEvent(makeEvent("acp.subagent_start", "e-fast-1"));
    await wake.handleEvent(makeEvent("acp.subagent_stop", "e-fast-2"));

    // Only the first passes; the second is throttled
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("after minIntervalMs elapses, next event passes through", async () => {
    const wake = new WakeSubscriber({
      path: SOCK,
      pi,
      minIntervalMs: 50,
    });

    await wake.handleEvent(makeEvent("acp.subagent_start", "e-gate-1"));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // Wait past the interval
    await new Promise((r) => setTimeout(r, 80));

    await wake.handleEvent(makeEvent("acp.subagent_stop", "e-gate-2"));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("burst of 10 events in 100ms → at most 1-2 calls to sendUserMessage", async () => {
    const wake = new WakeSubscriber({
      path: SOCK,
      pi,
      minIntervalMs: 1000,
    });

    for (let i = 0; i < 10; i++) {
      await wake.handleEvent(makeEvent("acp.subagent_start", `burst-${i}`));
      // tiny stagger — total still well under 100ms
      await new Promise((r) => setTimeout(r, 5));
    }

    const calls = pi.sendUserMessage.mock.calls.length;
    // The limiter must collapse the burst to at most 2 deliveries
    expect(calls).toBeLessThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("task_completed bypasses rate limiter (never throttled)", async () => {
    const wake = new WakeSubscriber({
      path: SOCK,
      pi,
      minIntervalMs: 1000,
    });

    // Prime the limiter with a non-completion event
    await wake.handleEvent(makeEvent("acp.subagent_start", "prime"));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // task_completed arrives immediately after — must NOT be throttled
    await wake.handleEvent(makeEvent("acp.task_completed", "complete-1"));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("session_completed bypasses rate limiter (never throttled)", async () => {
    const wake = new WakeSubscriber({
      path: SOCK,
      pi,
      minIntervalMs: 1000,
    });

    await wake.handleEvent(makeEvent("acp.subagent_start", "prime2"));
    await wake.handleEvent(makeEvent("acp.session_completed", "sess-done"));

    // Both delivered — session_completed is a NEVER_DROP event
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("default minIntervalMs is 1000ms when option omitted", async () => {
    const wake = new WakeSubscriber({ path: SOCK, pi });

    // Two rapid non-completion events with default limiter active
    await wake.handleEvent(makeEvent("acp.subagent_start", "d-1"));
    await wake.handleEvent(makeEvent("acp.subagent_stop", "d-2"));

    // Default limiter throttles the second
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

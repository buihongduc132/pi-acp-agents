/**
 * Tests for OT26 (yield on pending question) and OT15 (mode-branched renderer).
 *
 * These tests verify:
 * - OT26: Wake events yield when user has pending question
 * - OT15: Renderer configuration based on mode (tui/rpc)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketEvent } from "../../src/hooks/types.js";

function createMockPi(opts: { isIdle?: boolean; hasPendingUserQuestion?: boolean } = {}) {
  const { isIdle = true, hasPendingUserQuestion = false } = opts;
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    isIdle: vi.fn().mockReturnValue(isIdle),
    hasPendingUserQuestion: vi.fn().mockReturnValue(hasPendingUserQuestion),
    log: vi.fn(),
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

describe("wake-subscriber yield and renderer", () => {
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-wake-yield-"));
    sockPath = join(tmpDir, "events.sock");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("OT26 — yield on pending user question", () => {
    it("delivers as followUp when hasPendingUserQuestion()=true and isIdle()=true", async () => {
      const pi = createMockPi({ isIdle: true, hasPendingUserQuestion: true });
      const wake = new WakeSubscriber({ path: sockPath, pi, coalesceWindowMs: 0 } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-1"));

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = pi.sendMessage.mock.calls[0];
      expect(delivery.deliverAs).toBe("followUp");
      expect(delivery.triggerTurn).toBeFalsy();
    });

    it("triggers turn when hasPendingUserQuestion()=false and isIdle()=true", async () => {
      const pi = createMockPi({ isIdle: true, hasPendingUserQuestion: false });
      const wake = new WakeSubscriber({ path: sockPath, pi, coalesceWindowMs: 0 } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-2"));

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = pi.sendMessage.mock.calls[0];
      expect(delivery.triggerTurn).toBe(true);
    });

    it("uses normal idle-gate behavior when hasPendingUserQuestion is undefined (not provided)", async () => {
      const pi = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        isIdle: vi.fn().mockReturnValue(true),
        // hasPendingUserQuestion is undefined
        log: vi.fn(),
      };
      const wake = new WakeSubscriber({ path: sockPath, pi, coalesceWindowMs: 0 } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-3"));

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = pi.sendMessage.mock.calls[0];
      expect(delivery.triggerTurn).toBe(true);
    });

    it("buffers events when isIdle()=false, even if hasPendingUserQuestion()=true", async () => {
      const pi = createMockPi({ isIdle: false, hasPendingUserQuestion: true });
      const wake = new WakeSubscriber({ path: sockPath, pi, coalesceWindowMs: 0 } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-4"));

      // LD2: When agent is busy, events are buffered (not delivered immediately)
      expect(pi.sendMessage).not.toHaveBeenCalled();

      // When agent becomes idle and flush is called, event should be delivered
      // But hasPendingUserQuestion is still true, so delivery should be followUp
      pi.isIdle.mockReturnValue(true);
      await wake.flush();

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = pi.sendMessage.mock.calls[0];
      expect(delivery.deliverAs).toBe("followUp");
    });

    it("buffers events when isIdle()=false and hasPendingUserQuestion is not provided", async () => {
      const pi = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        isIdle: vi.fn().mockReturnValue(false),
        log: vi.fn(),
      };
      const wake = new WakeSubscriber({ path: sockPath, pi, coalesceWindowMs: 0 } as any);

      await wake.handleEvent(makeEvent("acp.task_completed", "evt-5"));

      // LD2: When agent is busy, events are buffered (not delivered immediately)
      expect(pi.sendMessage).not.toHaveBeenCalled();

      // When agent becomes idle and flush is called, event should be delivered
      pi.isIdle.mockReturnValue(true);
      await wake.flush();

      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const [, , delivery] = pi.sendMessage.mock.calls[0];
      expect(delivery.triggerTurn).toBe(true);
    });

    it("buffers wakes during pending question and flushes after question resolved", async () => {
      const pi = createMockPi({ isIdle: true, hasPendingUserQuestion: true });
      const wake = new WakeSubscriber({ path: sockPath, pi, coalesceWindowMs: 0 } as any);

      // First event while question pending
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-6"));
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(pi.sendMessage.mock.calls[0][2].deliverAs).toBe("followUp");

      // Question resolved
      pi.hasPendingUserQuestion.mockReturnValue(false);

      // Second event should trigger turn
      await wake.handleEvent(makeEvent("acp.task_completed", "evt-7"));
      expect(pi.sendMessage).toHaveBeenCalledTimes(2);
      expect(pi.sendMessage.mock.calls[1][2].triggerTurn).toBe(true);
    });
  });

  describe("OT15 — mode-branched renderer", () => {
    it("getRendererConfig() with mode:'tui' returns { component: 'AcpWakeComponent', mode: 'tui' }", () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi, mode: "tui" } as any);

      const config = wake.getRendererConfig();
      expect(config).toEqual({
        customType: "acp_wake",
        mode: "tui",
        component: "AcpWakeComponent",
      });
    });

    it("getRendererConfig() with mode:'rpc' returns { format: 'text', mode: 'rpc' }", () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi, mode: "rpc" } as any);

      const config = wake.getRendererConfig();
      expect(config).toEqual({
        customType: "acp_wake",
        mode: "rpc",
        format: "text",
      });
    });

    it("getRendererConfig() with no mode defaults to rpc", () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi } as any);

      const config = wake.getRendererConfig();
      expect(config).toEqual({
        customType: "acp_wake",
        mode: "rpc",
        format: "text",
      });
    });

    it("customType is always 'acp_wake' regardless of mode", () => {
      const pi = createMockPi();

      const wakeTui = new WakeSubscriber({ path: sockPath, pi, mode: "tui" } as any);
      const wakeRpc = new WakeSubscriber({ path: sockPath, pi, mode: "rpc" } as any);
      const wakeDefault = new WakeSubscriber({ path: sockPath, pi } as any);

      expect(wakeTui.getRendererConfig().customType).toBe("acp_wake");
      expect(wakeRpc.getRendererConfig().customType).toBe("acp_wake");
      expect(wakeDefault.getRendererConfig().customType).toBe("acp_wake");
    });

    it("getRendererConfig returns an object with a 'mode' field", () => {
      const pi = createMockPi();
      const wake = new WakeSubscriber({ path: sockPath, pi, mode: "tui" } as any);

      const config = wake.getRendererConfig();
      expect(config).toHaveProperty("mode");
      expect(config.mode).toBe("tui");
    });
  });
});

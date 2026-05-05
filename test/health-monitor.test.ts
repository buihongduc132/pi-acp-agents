import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthMonitor, type HealthMonitorable } from "../src/core/health-monitor.js";

function createMockSession(id: string, lastActivity?: Date): HealthMonitorable {
  return {
    sessionId: id,
    lastActivityAt: lastActivity ?? new Date(),
    disposed: false,
  };
}

describe("HealthMonitor", () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      intervalMs: 50,
      staleTimeoutMs: 200,
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  describe("registration", () => {
    it("registers sessions", () => {
      const session = createMockSession("s1");
      monitor.register(session);
      expect(monitor.size).toBe(1);
    });

    it("unregisters sessions", () => {
      const session = createMockSession("s1");
      monitor.register(session);
      monitor.unregister("s1");
      expect(monitor.size).toBe(0);
    });
  });

  describe("stale detection", () => {
    it("detects stale sessions", async () => {
      const oldDate = new Date(Date.now() - 300);
      const session = createMockSession("s1", oldDate);
      monitor.register(session);

      const staleIds = await monitor.check();
      expect(staleIds).toContain("s1");
    });

    it("does not flag active sessions", async () => {
      const session = createMockSession("s1", new Date());
      monitor.register(session);

      const staleIds = await monitor.check();
      expect(staleIds).not.toContain("s1");
    });

    it("removes disposed sessions during check", async () => {
      const session = createMockSession("s1");
      session.disposed = true;
      monitor.register(session);

      await monitor.check();
      expect(monitor.size).toBe(0);
    });
  });

  describe("isStale", () => {
    it("returns true for stale sessions", () => {
      const oldDate = new Date(Date.now() - 300);
      const session = createMockSession("s1", oldDate);
      monitor.register(session);

      expect(monitor.isStale("s1")).toBe(true);
    });

    it("returns false for active sessions", () => {
      const session = createMockSession("s1", new Date());
      monitor.register(session);

      expect(monitor.isStale("s1")).toBe(false);
    });

    it("returns false for unknown sessions", () => {
      expect(monitor.isStale("unknown")).toBe(false);
    });
  });

  describe("touch", () => {
    it("updates lastActivityAt", () => {
      const oldDate = new Date(Date.now() - 300);
      const session = createMockSession("s1", oldDate);
      monitor.register(session);

      expect(monitor.isStale("s1")).toBe(true);
      monitor.touch("s1");
      expect(monitor.isStale("s1")).toBe(false);
    });
  });

  describe("start/stop", () => {
    it("starts and stops monitoring", () => {
      expect(monitor.running).toBe(false);
      monitor.start();
      expect(monitor.running).toBe(true);
      monitor.stop();
      expect(monitor.running).toBe(false);
    });

    it("calls onStale callback for stale sessions", async () => {
      const onStale = vi.fn().mockResolvedValue(undefined);
      const mon = new HealthMonitor({
        intervalMs: 50,
        staleTimeoutMs: 100,
        onStale,
      });

      const oldDate = new Date(Date.now() - 200);
      mon.register(createMockSession("s1", oldDate));

      mon.start();
      await new Promise((r) => setTimeout(r, 200));
      mon.stop();

      expect(onStale).toHaveBeenCalledWith("s1");
    });
  });
});

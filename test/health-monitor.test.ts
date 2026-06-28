import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthMonitor, type HealthMonitorable } from "../src/core/health-monitor.js";
import { SessionManager } from "../src/core/session-manager.js";
import { getSessionAutoCloseReason } from "../src/core/session-lifecycle.js";
import type { AcpSessionHandle } from "../src/config/types.js";

function makeHandle(id: string): AcpSessionHandle {
  return {
    sessionId: id,
    agentName: "gemini",
    cwd: "/tmp",
    createdAt: new Date(),
    lastActivityAt: new Date(),
    lastResponseAt: undefined,
    completedAt: undefined,
    accumulatedText: "",
    disposed: false,
    busy: false,
    autoClosed: false,
    closeReason: undefined,
    planStatus: "none",
    dispose: async () => {
      // no-op; disposed flag set by closeSession simulation below
    },
  };
}

function createMockSession(id: string, lastActivity?: Date): HealthMonitorable {
  return {
    sessionId: id,
    lastActivityAt: lastActivity ?? new Date(),
    lastResponseAt: undefined,
    completedAt: undefined,
    busy: false,
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
    it("does not detect generic lastActivityAt-only idle sessions", async () => {
      const oldDate = new Date(Date.now() - 300);
      const session = createMockSession("s1", oldDate);
      monitor.register(session);

      const staleIds = await monitor.check();
      expect(staleIds).not.toContain("s1");
    });

    it("detects no-response stalls independently from lastActivityAt", async () => {
      const session = createMockSession("s2", new Date());
      session.busy = true;
      session.lastResponseAt = new Date(Date.now() - 300);
      monitor.register(session);

      const staleIds = await monitor.check();
      expect(staleIds).toContain("s2");
    });

    it("detects completed-idle sessions independently from lastActivityAt", async () => {
      const session = createMockSession("s3", new Date());
      session.completedAt = new Date(Date.now() - 300);
      monitor.register(session);

      const staleIds = await monitor.check();
      expect(staleIds).toContain("s3");
    });

    it("does not flag busy sessions before the first response arrives", async () => {
      const session = createMockSession("s1", new Date(Date.now() - 500));
      session.busy = true;
      monitor.register(session);

      const staleIds = await monitor.check();
      expect(staleIds).not.toContain("s1");
    });

    it("does not flag active sessions", async () => {
      const session = createMockSession("s4", new Date());
      monitor.register(session);

      const staleIds = await monitor.check();
      expect(staleIds).not.toContain("s4");
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
    it("returns true for no-response stalled sessions", () => {
      const session = createMockSession("s1", new Date());
      session.busy = true;
      session.lastResponseAt = new Date(Date.now() - 300);
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
    it("updating lastActivityAt alone does not clear no-response stalls", () => {
      const session = createMockSession("s1", new Date());
      session.busy = true;
      session.lastResponseAt = new Date(Date.now() - 300);
      monitor.register(session);

      expect(monitor.isStale("s1")).toBe(true);
      monitor.touch("s1");
      expect(monitor.isStale("s1")).toBe(true);
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

      const session = createMockSession("s1", new Date());
      session.busy = true;
      session.lastResponseAt = new Date(Date.now() - 200);
      mon.register(session);

      mon.start();
      await new Promise((r) => setTimeout(r, 200));
      mon.stop();

      expect(onStale).toHaveBeenCalledWith("s1");
    });
  });

  describe("T2: end-to-end TTL reaping converges in one cycle", () => {
    it("removes completed-idle and stalled-no-response sessions from BOTH registry and monitor after one check() -> onStale cycle", async () => {
      // Registry (SessionManager) + activeAdapters stand-in, mirroring index.ts.
      const sessionMgr = new SessionManager();
      const archived: string[] = [];

      // closeSession simulation: archive metadata, dispose adapter, remove from registry.
      async function closeSession(handle: AcpSessionHandle, closeReason: string) {
        handle.closeReason = closeReason;
        archived.push(handle.sessionId);
        await sessionMgr.remove(handle.sessionId);
      }

      // The onStale handler mirrors index.ts: look up the handle, compute the
      // auto-close reason, and route through closeSession.
      const onStale = async (sessionId: string): Promise<void> => {
        const handle = sessionMgr.get(sessionId);
        if (!handle) return;
        const closeReason = getSessionAutoCloseReason(handle, 200);
        if (closeReason) {
          await closeSession(handle, closeReason);
        }
      };

      const monitor = new HealthMonitor({
        intervalMs: 50,
        staleTimeoutMs: 200,
        onStale,
      });

      // completed-idle session: completedAt older than staleTimeoutMs
      const completedIdle = makeHandle("completed");
      completedIdle.completedAt = new Date(Date.now() - 300);
      // stalled-no-response session: busy with lastResponseAt older than staleTimeoutMs
      const stalled = makeHandle("stalled");
      stalled.busy = true;
      stalled.lastResponseAt = new Date(Date.now() - 300);

      sessionMgr.add(completedIdle);
      sessionMgr.add(stalled);
      monitor.register(completedIdle);
      monitor.register(stalled);

      expect(sessionMgr.size).toBe(2);
      expect(monitor.size).toBe(2);

      // Drive exactly ONE check() cycle then the onStale callback for each id
      // (this is what the start() interval loop does per tick).
      const staleIds = await monitor.check();
      expect(staleIds.sort()).toEqual(["completed", "stalled"]);
      for (const id of staleIds) {
        await onStale(id);
      }

      // THE GAP: entries must be gone from BOTH the registry and the monitor.
      expect(sessionMgr.get("completed")).toBeUndefined();
      expect(sessionMgr.get("stalled")).toBeUndefined();
      expect(sessionMgr.size).toBe(0);
      expect(archived.sort()).toEqual(["completed", "stalled"]);
      // This is the failing assertion that captures the bug: the monitor's
      // internal entries map does not converge to zero in a single cycle.
      expect(monitor.size).toBe(0);
      expect(monitor.isStale("completed")).toBe(false);
      expect(monitor.isStale("stalled")).toBe(false);

      monitor.stop();
    });

    it("SessionManager.pruneStale produces the identical dispose + delete effect", async () => {
      const sessionMgr = new SessionManager();
      const disposed: string[] = [];

      const completedIdle = makeHandle("completed");
      completedIdle.completedAt = new Date(Date.now() - 300);
      completedIdle.dispose = async () => {
        completedIdle.disposed = true;
        disposed.push(completedIdle.sessionId);
      };
      const stalled = makeHandle("stalled");
      stalled.busy = true;
      stalled.lastResponseAt = new Date(Date.now() - 300);
      stalled.dispose = async () => {
        stalled.disposed = true;
        disposed.push(stalled.sessionId);
      };

      sessionMgr.add(completedIdle);
      sessionMgr.add(stalled);

      const result = await sessionMgr.pruneStale(200);
      expect(result.removedSessionIds.sort()).toEqual(["completed", "stalled"]);
      expect(sessionMgr.size).toBe(0);
      expect(sessionMgr.get("completed")).toBeUndefined();
      expect(sessionMgr.get("stalled")).toBeUndefined();
      expect(disposed.sort()).toEqual(["completed", "stalled"]);
    });

    it("getSessionAutoCloseReason returns undefined for a busy session with no lastResponseAt (first-response protection)", () => {
      const firstResponse = makeHandle("first");
      firstResponse.busy = true;
      firstResponse.lastResponseAt = undefined;
      // No completedAt either — waiting for the very first response.
      expect(getSessionAutoCloseReason(firstResponse, 200)).toBeUndefined();
    });
  });
});

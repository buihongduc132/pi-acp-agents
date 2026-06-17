import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { HealthMonitor, type HealthMonitorable } from "../src/core/health-monitor.js";
import { getSessionAutoCloseReason } from "../src/core/session-lifecycle.js";
import type { AcpSessionHandle } from "../src/config/types.js";

function makeHandle(id: string, lastActivityAt = new Date()): AcpSessionHandle {
  return {
    sessionId: id,
    agentName: id.startsWith("g") ? "gemini" : "claude",
    cwd: "/tmp",
    createdAt: new Date(),
    lastActivityAt,
    lastResponseAt: undefined,
    completedAt: undefined,
    accumulatedText: "",
    disposed: false,
    busy: false,
    autoClosed: false,
    closeReason: undefined,
    planStatus: "none",
    dispose: async () => {},
  };
}

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it("adds and retrieves sessions", () => {
    const handle = makeHandle("s1");
    manager.add(handle);
    expect(manager.get("s1")).toBe(handle);
    expect(manager.size).toBe(1);
  });

  it("returns undefined for unknown session", () => {
    expect(manager.get("unknown")).toBeUndefined();
  });

  it("lists all sessions", () => {
    manager.add(makeHandle("g1"));
    manager.add(makeHandle("c2"));
    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.sessionId)).toEqual(["g1", "c2"]);
  });

  it("filters sessions by agent name", () => {
    manager.add(makeHandle("g1"));
    manager.add(makeHandle("c2"));
    expect(manager.listByAgent("gemini").map((s) => s.sessionId)).toEqual(["g1"]);
  });

  it("removes a session", async () => {
    manager.add(makeHandle("g1"));
    manager.add(makeHandle("c2"));
    await manager.remove("g1");
    expect(manager.get("g1")).toBeUndefined();
    expect(manager.size).toBe(1);
  });

  it("disposeAll removes all sessions", async () => {
    manager.add(makeHandle("s1"));
    manager.add(makeHandle("s2"));
    manager.add(makeHandle("s3"));
    await manager.disposeAll();
    expect(manager.size).toBe(0);
  });

  it("remove on unknown session is safe", async () => {
    await manager.remove("nonexistent");
  });

  it("prunes stalled-response, completed-idle, and disposed sessions only", async () => {
    const now = Date.now();
    const busyNoResponseYet = makeHandle("g0", new Date(now - 10_000));
    busyNoResponseYet.busy = true;

    const stalled = makeHandle("g1", new Date(now - 1_000));
    stalled.busy = true;
    stalled.lastResponseAt = new Date(now - 10_000);

    const completedIdle = makeHandle("c2", new Date(now - 1_000));
    completedIdle.completedAt = new Date(now - 10_000);

    const disposed = makeHandle("c3");
    disposed.disposed = true;

    manager.add(busyNoResponseYet);
    manager.add(stalled);
    manager.add(completedIdle);
    manager.add(disposed);

    const result = await manager.pruneStale(5_000, now);

    expect(result.removedSessionIds.sort()).toEqual(["c2", "c3", "g1"]);
    expect(manager.list().map((s) => s.sessionId)).toEqual(["g0"]);
  });

  it("size is accurate", () => {
    expect(manager.size).toBe(0);
    manager.add(makeHandle("s1"));
    expect(manager.size).toBe(1);
  });

  describe("T3: idempotency — remove() and closeSession do not double-dispose", () => {
    it("remove() does not call dispose() again if handle.disposed is already true (T1's hook already ran)", async () => {
      let disposeCallCount = 0;
      const handle = makeHandle("s1");
      handle.dispose = async () => {
        handle.disposed = true;
        disposeCallCount++;
      };

      // Simulate T1's completion hook: it calls dispose() directly, sets disposed=true
      await handle.dispose();
      expect(disposeCallCount).toBe(1);
      expect(handle.disposed).toBe(true);

      // Then T2's reaper (or a second closeSession) calls remove()
      manager.add(handle);
      expect(manager.size).toBe(1);

      await manager.remove("s1");

      // BUG: remove() should NOT call dispose() again. It should detect disposed=true and skip.
      expect(disposeCallCount).toBe(1);
      expect(manager.size).toBe(0);
    });

    it("pruneStale() does not call dispose() again if handle.disposed is already true", async () => {
      let disposeCallCount = 0;
      const handle = makeHandle("s1");
      handle.completedAt = new Date(Date.now() - 10_000);
      handle.dispose = async () => {
        handle.disposed = true;
        disposeCallCount++;
      };

      // Simulate T1's completion hook
      await handle.dispose();
      expect(disposeCallCount).toBe(1);
      expect(handle.disposed).toBe(true);

      manager.add(handle);
      const result = await manager.pruneStale(5_000);

      expect(result.removedSessionIds).toContain("s1");
      // BUG: pruneStale should NOT call dispose() again
      expect(disposeCallCount).toBe(1);
      expect(manager.size).toBe(0);
    });

    it("disposeAll() does not call dispose() again on already-disposed handles", async () => {
      let disposeCallCount = 0;
      const handle = makeHandle("s1");
      handle.dispose = async () => {
        handle.disposed = true;
        disposeCallCount++;
      };

      await handle.dispose();
      expect(disposeCallCount).toBe(1);

      manager.add(handle);
      await manager.disposeAll();

      // BUG: disposeAll should NOT call dispose() again
      expect(disposeCallCount).toBe(1);
      expect(manager.size).toBe(0);
    });

    it("health monitor check() removes disposed sessions from monitor map on next tick", async () => {
      const monitor = new HealthMonitor({
        intervalMs: 50,
        staleTimeoutMs: 200,
      });

      const handle = makeHandle("s1");
      monitor.register(handle);
      expect(monitor.size).toBe(1);

      // Simulate T1's hook disposing the session
      handle.disposed = true;

      // Next check() should detect disposed and remove from monitor
      const staleIds = await monitor.check();
      expect(staleIds).not.toContain("s1"); // not stale, just disposed
      expect(monitor.size).toBe(0); // BUG: should be removed from monitor map

      monitor.stop();
    });

    it("health monitor check() does not reprocess a session disposed by T1's hook (no double stale callback)", async () => {
      let onStaleCallCount = 0;
      const monitor = new HealthMonitor({
        intervalMs: 50,
        staleTimeoutMs: 200,
        onStale: async (sessionId: string) => {
          onStaleCallCount++;
        },
      });

      const handle = makeHandle("s1");
      handle.completedAt = new Date(Date.now() - 300); // stale
      monitor.register(handle);

      // Simulate one start() tick: check() returns stale ids, then onStale is called for each
      const staleIds1 = await monitor.check();
      expect(staleIds1).toContain("s1");
      for (const id of staleIds1) {
        await monitor["opts"].onStale!(id);
      }
      expect(onStaleCallCount).toBe(1);

      // Simulate T1's hook disposing the session (after onStale callback)
      handle.disposed = true;

      // Second check: session should be gone, NOT reprocessed
      const staleIds2 = await monitor.check();
      expect(staleIds2).not.toContain("s1");
      for (const id of staleIds2) {
        await monitor["opts"].onStale!(id);
      }
      expect(onStaleCallCount).toBe(1); // BUG: should still be 1, not 2
      expect(monitor.size).toBe(0);

      monitor.stop();
    });
  });
});

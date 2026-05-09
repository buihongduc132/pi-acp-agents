import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
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
});

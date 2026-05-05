import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import type { AcpSessionHandle } from "../src/config/types.js";

function makeHandle(id: string): AcpSessionHandle {
  return {
    sessionId: id,
    agentName: "test",
    cwd: "/tmp",
    createdAt: new Date(),
    lastActivityAt: new Date(),
    accumulatedText: "",
    disposed: false,
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
    manager.add(makeHandle("s1"));
    manager.add(makeHandle("s2"));
    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("removes a session", async () => {
    manager.add(makeHandle("s1"));
    manager.add(makeHandle("s2"));
    await manager.remove("s1");
    expect(manager.get("s1")).toBeUndefined();
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

  it("size is accurate", () => {
    expect(manager.size).toBe(0);
    manager.add(makeHandle("s1"));
    expect(manager.size).toBe(1);
  });
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SessionNameStore } from "../src/management/session-name-store.js";

describe("SessionNameStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "acp-session-name-store-"));
    dirs.push(dir);
    return { dir, store: new SessionNameStore(dir) };
  }

  it("persists friendly name mappings across reloads", () => {
    const { dir, store } = makeStore();
    store.register("alpha", "session-1");

    const reloaded = new SessionNameStore(dir);
    expect(reloaded.getSessionId("alpha")).toBe("session-1");
    expect(reloaded.getName("session-1")).toBe("alpha");
  });

  it("normalizes friendly names and rejects whitespace-only values", () => {
    const { store } = makeStore();
    store.register("  alpha  ", "session-1");

    expect(store.getSessionId("alpha")).toBe("session-1");
    expect(store.getSessionId(" alpha ")).toBe("session-1");
    expect(store.getName("session-1")).toBe("alpha");
    expect(() => store.register("   ", "session-2")).toThrow('session_name is required');
  });

  it("rejects duplicate friendly names for different sessions", () => {
    const { store } = makeStore();
    store.register("alpha", "session-1");

    expect(() => store.register("alpha", "session-2")).toThrow('Session name "alpha" is already assigned to session "session-1".');
  });

  it("allows idempotent re-registration for the same session", () => {
    const { store } = makeStore();
    store.register("alpha", "session-1");

    expect(store.register("alpha", "session-1").sessionId).toBe("session-1");
  });

  it("falls back to empty state on corrupt registry file", () => {
    const { dir } = makeStore();
    const runtimeDir = join(dir, ".pi-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "session-name-registry.json"), "{not-json", "utf8");

    const store = new SessionNameStore(runtimeDir, { treatAsRuntimeDir: true });
    expect(store.getSessionId("alpha")).toBeUndefined();
    store.register("alpha", "session-1");
    expect(store.getSessionId("alpha")).toBe("session-1");
  });

  it("retains archived-session mappings after later updates", () => {
    const { dir, store } = makeStore();
    store.register("alpha", "session-1");
    store.register("beta", "session-2");

    const payload = readFileSync(join(dir, "session-name-registry.json"), "utf8");
    expect(payload).toContain("alpha");
    expect(payload).toContain("beta");
    expect(new SessionNameStore(dir, { treatAsRuntimeDir: true }).getSessionId("alpha")).toBe("session-1");
  });
});

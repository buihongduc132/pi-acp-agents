import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("R9 — SessionNameStore reopen-after-cleanup support", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "r9-registry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("register is idempotent for the same name→session pair (reopen self-assignment)", async () => {
    const { SessionNameStore } = await import("../src/management/session-name-store.js");
    const store = new SessionNameStore(dir, { treatAsRuntimeDir: true });
    expect(() => store.register("r9-sess", "s-1")).not.toThrow();
    expect(() => store.register("r9-sess", "s-1")).not.toThrow();
    expect(store.getSessionId("r9-sess")).toBe("s-1");
  });

  it("release(sessionId) purges registry entries so the name is reusable by a new session", async () => {
    const { SessionNameStore } = await import("../src/management/session-name-store.js");
    const store = new SessionNameStore(dir, { treatAsRuntimeDir: true });
    store.register("r9-sess", "s-old");
    expect(typeof (store as any).release).toBe("function");
    (store as any).release("s-old");
    expect(store.getSessionId("r9-sess")).toBeUndefined();
    expect(store.getName("s-old")).toBeUndefined();
    expect(() => store.register("r9-sess", "s-new")).not.toThrow();
    expect(store.getSessionId("r9-sess")).toBe("s-new");
  });
});

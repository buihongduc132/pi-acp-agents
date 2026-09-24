import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionNameStore } from "../src/management/session-name-store.js";

/**
 * Reproduces gh#50: acp_msg reopen by session_id fails for named spawns.
 *
 * Scenario (from flow/findings/2026-08-16_acp-reopen-name-mismatch.md):
 *   1. acp_spawn {name:"rpc-r9-resume-abc"} registers PLAIN name → registry
 *   2. Archive metadata stores SUFFIXED name "rpc-r9-resume-abc-c01e-b2c1"
 *   3. Reopen via acp_msg {session_id:<id>} resolves sessionName from archive
 *      (SUFFIXED), then calls register(suffixedName, sessionId)
 *   4. register() throws: "Session X is already assigned friendly name Y"
 *      because the registry maps sessionId → PLAIN name ≠ SUFFIXED name
 *
 * Fix: register() should be idempotent when the sessionId already has a
 * mapping — prefer the existing name rather than throwing.
 */
describe("gh#50 — reopen with suffixed name must not throw when sessionId already mapped", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gh50-reopen-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("register(suffixedName, existingSessionId) does NOT throw — prefers existing mapping", () => {
    const store = new SessionNameStore(dir, { treatAsRuntimeDir: true });

    // Step 1: spawn registers PLAIN name (as acp_spawn does via sessionNameStore.register)
    const plainName = "rpc-r9-resume-abc";
    const sessionId = "01a00bed-f3e6-75bd-aa17-ebd37bfc6748";
    store.register(plainName, sessionId);

    // Verify initial state
    expect(store.getSessionId(plainName)).toBe(sessionId);
    expect(store.getName(sessionId)).toBe(plainName);

    // Step 2: reopen path calls register with SUFFIXED name (from archive metadata)
    const suffixedName = "rpc-r9-resume-abc-c01e-b2c1";

    // BUG: This currently throws "Session X is already assigned friendly name Y"
    // FIX: Should NOT throw — should prefer existing mapping or update to new name
    expect(() => store.register(suffixedName, sessionId)).not.toThrow();

    // After fix: sessionId should still be accessible (either by plain or suffixed name)
    expect(store.getName(sessionId)).toBeDefined();
  });

  it("register with genuinely different sessionId for same name still throws", () => {
    const store = new SessionNameStore(dir, { treatAsRuntimeDir: true });
    store.register("alpha", "session-1");

    // This SHOULD throw — different session claiming the same name
    expect(() => store.register("alpha", "session-2")).toThrow(
      'Session name "alpha" is already assigned to session "session-1"'
    );
  });
});

# PLAN — Fix Dispose Chain + Map/State Leaks (G5–G12)

Scope: dispose lifecycle + in-memory map coherence in `index.ts`,
`src/core/session-manager.ts`, `src/adapters/base.ts`, `src/core/client.ts`.

Status: **PLAN ONLY — no source changes, no commit.**

Refs:
- index.ts: `closeSession()`, `makeSessionHandle()` (inline `dispose`),
  `acp_prompt` tool (esp. `dispose: true` ephemeral path),
  `acp_worker_shutdown` / `acp_worker_kill` tools, `session_shutdown` hook.
- Maps: `activeAdapters`, `busySessions`, `workerSessionMap`.
- `SessionManager.remove()` / `disposeAll()` → call `handle.dispose()`.
- `HealthMonitor.register/unregister` (`src/core/health-monitor.ts`).

---

## 1. Problem (per bug)

| ID | Symptom |
|----|---------|
| **G5** | `AcpAgentAdapter.dispose(): void` calls `this.client.dispose()` (returns `Promise<void>`) **fire-and-forget**. Body has no `await` today → no observable break, but a single `await` added to `AcpClient.dispose()` later (G6 fix) turns this into an un-awaited rejection → silent swallow, premature adapter reuse, or zombie child. |
| **G6** | `AcpClient.dispose()` calls `killWithEscalation()` directly. No `proc.stdin.end()` first → agent never sees EOF → cannot flush its session file. Risk: partial writes / corrupted on-disk session state. |
| **G7** | `connected` getter = `conn != null && proc != null && !proc.killed`. `proc.killed` flips true the instant `kill()` is called, **regardless of delivery**. Disposed adapter reports "disconnected" while the OS process is still draining SIGTERM grace window. |
| **G8** | `AcpClient.dispose()` nulls `conn/proc/_sessionId` but leaves `sessionLogger`, `collectedText`, `lastStderr`, `onActivity`, `onSessionUpdate`, `spawnErrorListeners` referenced on the instance until GC. Adapters are held in `activeAdapters` until teardown; if cleanup is skipped, closures (heartbeat consumer) outlive the session. |
| **G9** | `handle.dispose()` (inline in `makeSessionHandle`) and `closeSession()` BOTH run `adapter.dispose() + activeAdapters.delete`. Order is fragile: `closeSession` calls `sessionMgr.remove()` → which calls `handle.dispose()` (adapter disposed + map entry deleted) → then `closeSession` re-deletes `activeAdapters`. If `handle.dispose` throws, `activeAdapters.delete` is skipped inside the dispose callback, but `closeSession` still runs its own `.delete`. Works by accident; any reordering breaks. |
| **G10** | `closeSession()` cleans `activeAdapters` + `busySessions` but **not** `workerSessionMap`. If a worker-bound session is closed via staleness (onStale), the `sessionId → workerName` mapping survives → `WorkerDispatcher.getSessionIdForWorker` / `heartbeatDeps.resolveWorkerName` route heartbeats to a dead session. |
| **G11** | `workerSessionMap` is **never pruned on normal (non-worker) session close**. Same root as G10. |
| **G12** | `busySessions` is set in `finally` blocks in `acp_prompt` but `closeSession` has **no try/finally** around map cleanup. If `sessionMgr.remove()` throws (because `handle.dispose()` threw before the `try/catch` swallowed it... it does catch, but archiveSession before it, or a future addition, can throw), `busySessions` + `activeAdapters` entries leak. |

---

## 2. Root Cause

**Single root cause:** cleanup logic is **duplicated across ≥4 call sites**,
each touching a **different subset** of the 4 coordinated maps
(`activeAdapters`, `busySessions`, `workerSessionMap`, `monitor.entries`).

| Site | activeAdapters | busySessions | workerSessionMap | monitor | adapter.dispose awaited |
|------|:-:|:-:|:-:|:-:|:-:|
| `closeSession` (onStale path) | ✓ | ✓ | ✗ | ✗ | ✗ |
| `handle.dispose` (inline) | ✓ | ✗ | ✗ | ✗ | ✗ |
| `acp_worker_shutdown` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `acp_worker_kill` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `session_shutdown` hook | ✓ (clear) | ✗ | ✗ | ✓ (stop) | ✗ |

Add: `AcpClient.dispose()` is not EOF-safe and not ref-clearing (G6/G8),
and the adapter-to-client dispose is a sync→async fire-and-forget seam (G5).

**Fix principle:** one canonical closer, all maps, all paths, awaited chain,
stdin EOF before kill.

---

## 3. Solution

### 3.1 `AcpClient.dispose()` (src/core/client.ts)

```ts
async dispose(): Promise<void> {
  this.disposed = true;                  // GAP-4 invariant preserved
  this.spawnErrorListeners = [];
  this.spawnError = null;
  this.processExitError = null;

  // G6: stdin EOF FIRST so agent can flush session file.
  if (this.proc?.stdin && !this.proc.stdin.destroyed) {
    try { await new Promise<void>((res) =>
      this.proc!.stdin!.end(() => res())); }
    catch { /* best-effort */ }
  }

  if (this.proc && !this.proc.killed) killWithEscalation(this.proc);

  // G8: clear ALL retained refs/closures.
  this.conn = null;
  this.proc = null;
  this._sessionId = null;
  this._agentInfo = null;
  this.sessionLogger = undefined;
  this.collectedText = "";
  this.lastStderr = "";
  this.onActivity = undefined;
  this.onSessionUpdate = undefined;
}
```

### 3.2 `AcpAgentAdapter.dispose()` → async (src/adapters/base.ts)

```ts
async dispose(): Promise<void> {
  if (this.client) {
    try { await this.client.dispose(); }   // G5: AWAIT the chain
    catch { /* dispose must not throw */ }
    this.client = null;
  }
}
```

**Caveat / migration:** every current call site is `adapter.dispose();`
(sync, un-awaited). They MUST become `await adapter.dispose();`. This is
exactly what §3.3 centralizes, so no call site keeps the sync form.

### 3.3 Canonical closer in `index.ts`

```ts
/**
 * SINGLE source of truth for session teardown.
 * Order: archive → adapter.dispose (await, EOF+kill) → clear ALL maps.
 * Idempotent: safe to call twice; second pass is a no-op.
 */
async function teardownSession(
  sessionId: string,
  opts?: { reason?: string; markDisposed?: boolean },
): Promise<void> {
  const handle = sessionMgr.get(sessionId);

  // 1. Mark handle disposed + archive reason (only if handle still live).
  if (handle && opts?.markDisposed !== false) {
    handle.disposed = true;
    if (opts?.reason) handle.closeReason = opts.reason;
    archiveSession(handle);
  }

  // 2. Await the full dispose chain (stdin EOF → kill → ref-clear).
  const adapter = activeAdapters.get(sessionId);
  if (adapter) {
    try { await adapter.dispose(); }
    catch (err) { logger.error("teardownSession adapter.dispose failed", { sessionId, error: String(err) }); }
  }

  // 3. Clear ALL coordinated state — order-independent, defensive.
  activeAdapters.delete(sessionId);
  busySessions.delete(sessionId);
  workerSessionMap.delete(sessionId);   // G10/G11
  monitor.unregister(sessionId);        // deterministic vs auto-prune
  sessionMgr.remove(sessionId);         // no-op if already removed; safe
}
```

**Note:** `sessionMgr.remove()` itself calls `handle.dispose()`. To avoid a
second dispose pass, `handle.dispose()` must become a **thin guard** that
delegates to `teardownSession` only when not already disposed — OR
`sessionMgr.remove()` is bypassed in `teardownSession` and the handle is
removed via a new `sessionMgr.delete(sessionId)` (no dispose side-effect).
**Recommend the second** (add `SessionManager.delete(id)` — pure map delete),
to break the recursion cleanly. `remove()` stays for external callers that
want dispose semantics.

### 3.4 Call sites that MUST route through `teardownSession`

| # | Site | Replacement |
|---|------|-------------|
| 1 | `closeSession(handle, reason, auto)` | body becomes: set `handle.autoClosed/closeReason` → `archiveSession` → `await teardownSession(handle.sessionId, { reason })` → `eventLog.append("session_closed", …)` |
| 2 | inline `dispose` in `makeSessionHandle` | `dispose: async () => { if (handle.disposed) return; await teardownSession(sessionId, { reason: "manual-dispose" }); }` |
| 3 | `acp_prompt` ephemeral `dispose:true` path (line ~746) | `await teardownSession(sessionId, { reason: "ephemeral" });` instead of `adapter.dispose();` |
| 4 | `acp_prompt` spawn-error catch blocks (`adapter.dispose(); throw`) ×3 (lines ~652/681/701/712/749) | `await teardownSession(sessionId, { reason: "spawn-error" });` — but note these run BEFORE `makeSessionHandle`, so only `activeAdapters` has the entry; `teardownSession` must tolerate missing handle (already does). |
| 5 | `acp_worker_shutdown` body (lines ~1466–1470) | replace the 4-line manual cleanup with `await teardownSession(sessionId, { reason: "worker-shutdown" });` |
| 6 | `acp_worker_kill` body (lines ~1513–1517) | `await teardownSession(sessionId, { reason: "worker-kill" });` |
| 7 | `session_shutdown` hook (lines ~1756–1764) | `for (const id of [...sessionMgr.list(), ...activeAdapters.keys()]) await teardownSession(id, { reason: "host-shutdown" });` — single loop, dedup IDs, no second manual `activeAdapters.clear()` loop. |

### 3.5 G7 fix — `connected` getter

Replace `!proc.killed` with an explicit `disposed` flag check:

```ts
get connected(): boolean {
  return !this.disposed && this.conn !== null && this.proc !== null && !this.proc.killed;
}
```

`disposed` is already set true at top of `dispose()` (GAP-4). This makes
"connected" reflect **our lifecycle intent**, not libuv's kill-delivery
timing. (Optional: also expose `isAlive()` that returns `!proc.killed &&
proc.exitCode === null` for callers that genuinely want OS-level liveness.)

---

## 4. TDD Test Cases (vitest)

New file: `test/teardown-session.test.ts`.
Helpers: extend existing fake-adapter harness from `test/client-deep.test.ts`
(`makeFakeProc`, `createClient`) and the session-manager harness from
`test/session-manager.test.ts`.

> **Assert invariant for every case:** after close, ALL of
> `activeAdapters.has(sid)`, `busySessions.has(sid)`,
> `workerSessionMap.has(sid)`, `monitor.isStale(sid)` (or `monitor.size`
> delta) are **false**, AND `adapter.dispose` was awaited exactly once,
> AND `proc.stdin.end` was called before `kill`.

| # | Name | Setup | Assert |
|---|------|-------|--------|
| T1 | `closeSession clears all 4 maps` | register live handle, busy=true, worker-mapped | after `closeSession(h, "stale", true)` → all 4 maps empty for sid; `session_closed` event logged |
| T2 | `handle.dispose() clears all 4 maps` | same setup | after `await handle.dispose()` → all 4 empty; idempotent (second call no-throw, no double dispose) |
| T3 | `worker_shutdown clears all 4 maps` | worker-bound session | tool call → all 4 empty; worker status offline; `worker_shutdown` event |
| T4 | `worker_kill clears all 4 maps` | worker-bound + currentTask | tool call → all 4 empty; task → pending; worker offline |
| T5 | `onStale path clears workerSessionMap (G10/G11)` | worker-bound, idle past staleTimeout | monitor fires → `closeSession` → workerSessionMap empty → next heartbeat for that worker no-ops |
| T6 | `busySessions cleaned even if adapter.dispose throws (G12)` | fake adapter whose dispose rejects | `closeSession` does NOT throw uncaught; `busySessions`/`activeAdapters` still empty after |
| T7 | `acp_prompt ephemeral dispose:true clears maps` | dispose:true prompt completes | adapter disposed, all maps empty, no handle in sessionMgr |
| T8 | `acp_prompt spawn-error catch clears maps` | fake ENOENT on spawn | catch path runs `teardownSession` → `activeAdapters` empty (handle never created) |
| T9 | `session_shutdown hook clears every session + every worker` | mix of normal + worker sessions, one orphan in activeAdapters only | after hook: sessionMgr.size===0, activeAdapters.size===0, busySessions.size===0, workerSessionMap.size===0; each adapter disposed exactly once |
| T10 | `stdin EOF before SIGTERM (G6)` | spy on fake proc.stdin.end + proc.kill | `stdin.end` called BEFORE first `kill`; ordering asserted via call-index array |
| T11 | `adapter.dispose awaited chain (G5)` | fake client.dispose returns a promise that resolves on next tick; flag set in microtask | assert flag set BEFORE teardownSession resolves (proves await) |
| T12 | `AcpClient.dispose clears retained refs (G8)` | post-dispose, read private fields via test-only getter or cast | sessionLogger/collectedText/lastStderr/onActivity/onSessionUpdate all nulled/empty |
| T13 | `connected getter false after dispose even if proc.killed lagging (G7)` | dispose but stub proc.killed=false | `client.connected === false` (disposed flag wins) |
| T14 | `idempotent teardownSession — double call safe` | call twice | no throw, adapter.dispose called once total, maps empty |

Worst-first ordering: **T6, T10, T11** (regression-prone failure modes) first,
then map-coherence cases, then idempotency.

---

## 5. Rollout / Risk

**Risk levels:**
- **HIGH** — `AcpAgentAdapter.dispose()` signature change `void → Promise<void>`.
  Every call site that ignored the return now has a floating promise. §3.3
  forces all paths through `teardownSession` (which awaits), so the only
  remaining risk is a missed call site. **Mitigation:** grep
  `adapter.dispose()` / `\.dispose()` post-edit; all must be inside an
  awaited `teardownSession` or `await`-ed directly. Add ESLint
  `no-floating-promises` (already on in stricter TS configs) — verify.
- **MEDIUM** — `stdin.end()` callback timing. On some agents (Gemini CLI)
  stdin close may itself trigger exit before SIGTERM; that's desirable.
  Guard with try/catch + timeout (don't await indefinitely — wrap in
  `Promise.race` with 500ms cap). **Add to T10.**
- **MEDIUM** — `SessionManager.delete()` addition. Keep `remove()` for
  external API compat; document that `delete()` is internal-only and skips
  dispose.
- **LOW** — `teardownSession` adds one `await` per close. All close sites
  are already async. No sync→async boundary changes.
- **LOW** — `connected` getter semantics change. Callers that branched on
  `connected` to decide "can I reuse this adapter" get the *correct* answer
  now. Audit: only `quickPrompt()` and the widget status display use it.

**Rollout steps:**
1. Add `SessionManager.delete(id)` + test (session-manager.test.ts).
2. Implement `AcpClient.dispose()` EOF + ref-clear (T10/T12/T13).
3. Make `AcpAgentAdapter.dispose()` async (T11).
4. Add `teardownSession()` + wire all 7 call sites (§3.4).
5. Run full vitest suite; add T1–T14 incrementally (TDD: red → impl → green).
6. `gitnexus_detect_changes` before commit to confirm only expected symbols
   affected: `closeSession`, `makeSessionHandle`, `dispose` (handle),
   `acp_worker_shutdown`, `acp_worker_kill`, `session_shutdown` hook,
   `AcpClient.dispose`, `AcpAgentAdapter.dispose`, `SessionManager.delete`.

**Rollback:** revert is clean — no schema/data migration. On-disk session
files written under old behavior are unaffected (EOF just gives agents a
chance to flush; corrupted ones from before remain corrupted — out of scope).

---

## 6. OUT OF SCOPE

- Repairing already-corrupted on-disk session files (G6 is *prevention*).
- Replacing `HealthMonitor` interval-based pruning with event-driven
  removal (teardown just calls `unregister` deterministically; the
  interval stays as a safety net).
- Adding a generic "lifecycle framework" / state machine for sessions
  (YAGNI — `teardownSession` + boolean flags suffice).
- Worker task reassignment policy on kill (already handled in
  `acp_worker_kill` via `taskStore().update(... pending)` — unchanged).
- DAG cancel session abort path (`DagExecutor.cancel`) — separate dispose
  surface; will be addressed in its own plan if audit finds leaks.
- Windows `taskkill /T` EOF semantics (current code uses taskkill directly,
  no stdin pipe close needed; T10 is POSIX-only, guarded by `platform()`).
- Changing `archiveSession` durability / retention policy.
- Migrating `activeAdapters`/`busySessions`/`workerSessionMap` into a
  single `SessionRegistry` class (YAGNI for this fix; `teardownSession`
  gives the coherence guarantee without a new abstraction).

# Fix Health Monitor + Edge Case Leaks/Orphans

> **Status:** Draft
> **Scope:** G17–G23 (health monitor robustness + session leak/orphan edge cases)
> **Depends on:** Plan 1 (`fix-process-group-kill.md`) for G3 (process-group kill)

---

## 1. Problem

| ID  | Symptom                                                                                          |
| --- | ------------------------------------------------------------------------------------------------ |
| G17 | `onStale` callback failure → session stays in monitor Map → detected stale next tick → infinite retry loop |
| G18 | `check()` iterates `this.entries` while `register()` may add concurrently (from spawn in another tool call) → new entry missed in that cycle |
| G19 | Prompt stall detection uses `lastActivityAt` (set at session creation). Silent-but-working agent → false-positive close |
| G20 | `acp_prompt` with `dispose: true` calls `adapter.dispose()` but NOT `closeSession()` → session stays in sessionMgr, activeAdapters, monitor |
| G21 | `loadSession` throws → `adapter.dispose()` called, session never registered. Verify no half-archived metadata leak |
| G22 | `DagExecutor.resumeAll()` spawns adapters via coordinator that fail silently → not tracked in `activeAdapters` → leak on shutdown |
| G23 | No keepalive between pi host and ACP children. Half-open pipe → agent zombies forever |

---

## 2. Root Cause

**G17:** `HealthMonitor.start()` wraps `onStale(id)` in try/catch that only `console.error`. If `closeSession()` throws inside the callback, the session remains in `this.entries` and `check()` re-detects it stale on the next tick → infinite loop.

**G18:** `check()` does `for (const [id, entry] of this.entries)` — direct Map iteration. `register()` from a concurrent spawn adds entries that may be invisible to the current iteration (Map guarantees iteration over entries present at start, but the semantics are subtle and the code has no snapshot guard).

**G19:** `getPromptStallReason()` computes idle from `session.lastActivityAt`. For a new session where the prompt starts immediately but the agent is slow to emit first chunk, `lastActivityAt` = session creation time. If `staleTimeoutMs` is short or the agent genuinely needs time to think, the stall clock starts before any activity → false positive.

**G20:** In `acp_prompt` `dispose: true` path (index.ts ~line 576): `if (params.dispose) adapter.dispose()` — this only calls `adapter.dispose()` which kills the process. It does NOT call `closeSession()`, so the session remains in `sessionMgr`, `activeAdapters`, `monitor.entries`, and is never archived with a close reason.

**G21:** When `loadSession` throws in the archived-session path (index.ts ~line 538), `adapter.dispose()` is called, then a fresh adapter is created. The archived metadata gets `loadStatus: "unloadable"` and `loadAttemptCount++` written via `archiveSession(archived as AcpSessionHandle)`. The *original* adapter is disposed without ever being registered — no leak. **However**: if the fresh fallback also fails and throws, `freshAdapter.dispose()` is called but no `makeSessionHandle` was ever called → no monitor/sessionMgr leak. This path is clean but should be verified with a test.

**G22:** `DagExecutor.resumeAll()` creates a local `resumeCoordinator` + `resumeExecutor` inside an IIFE. The coordinator's `delegate()` calls create short-lived sessions that are managed by the coordinator itself, NOT by `activeAdapters` in index.ts. These sessions are ephemeral (one delegate call per step). On shutdown, `session_shutdown` disposes `activeAdapters` but DAG step adapters are not there. However, DAG step sessions are short-lived — the coordinator's delegate creates a session, prompts, and disposes. The risk is: if `resumeAll` starts a DAG that spawns an adapter and the adapter's process survives (e.g., the delegate hangs), there's no way to kill it on shutdown. **Root cause: no shared tracking between DAG executor and index.ts session lifecycle.**

**G23:** No process-level liveness check. A child agent whose stdio pipes are half-open (pipe writer doesn't know reader died) will never be detected as dead. The HealthMonitor interval checks `session.disposed` and stale reasons but never checks `proc.killed` / `proc.exitCode`.

---

## 3. Solution

### G17 — onStale failure → unregister after N retries, log once

**File:** `src/core/health-monitor.ts`

**Change:** Add per-session failure tracking to `TrackedEntry`. In `start()`, when `onStale` callback throws, increment `staleFailureCount`. After `MAX_STALE_FAILURES` (default: 3), force-unregister the session and log once.

```typescript
interface TrackedEntry {
  session: HealthMonitorable;
  attentionNotified: boolean;
  staleFailureCount: number;  // NEW
}
```

In `start()`:
```typescript
for (const id of staleIds) {
  try {
    await this.opts.onStale?.(id);
    // Success → reset counter
    const entry = this.entries.get(id);
    if (entry) entry.staleFailureCount = 0;
  } catch (err) {
    const entry = this.entries.get(id);
    if (entry) {
      entry.staleFailureCount++;
      if (entry.staleFailureCount >= (this.opts.maxStaleFailures ?? 3)) {
        console.error(`[acp-health] onStale failed ${entry.staleFailureCount}x for ${id}, force-unregistering`);
        this.entries.delete(id);
      } else {
        console.error(`[acp-health] onStale callback error (${entry.staleFailureCount}/${this.opts.maxStaleFailures ?? 3}):`, err);
      }
    }
  }
}
```

**New option:** `HealthMonitorOptions.maxStaleFailures?: number` (default 3).

### G18 — Snapshot keys at start of check()

**File:** `src/core/health-monitor.ts` → `check()`

**Change:** Replace `for (const [id, entry] of this.entries)` with snapshot iteration:

```typescript
async check(): Promise<string[]> {
  const staleIds: string[] = [];
  const toRemove: string[] = [];
  const snapshotIds = Array.from(this.entries.keys());  // ← snapshot

  for (const id of snapshotIds) {
    const entry = this.entries.get(id);
    if (!entry) continue;  // unregistered during this cycle
    // ... existing logic
  }
  // ... existing toRemove cleanup
}
```

### G19 — Use promptStartedAt as baseline; require at least one touch

**File:** `src/core/health-monitor.ts` → `getPromptStallReason()`

**Change:** Simpler fix: require at least one `touch()` before stall clock starts. If `isPrompting` is true but `lastActivityAt` equals the session's creation time (no touch ever), return `undefined` (not stalled). Additionally, use `promptStartedAt` as the baseline instead of `lastActivityAt` for the stall calculation — the stall clock should measure "time since prompt started without meaningful activity", not "time since session creation".

```typescript
private getPromptStallReason(session: HealthMonitorable): PromptStallReason | undefined {
  const autoInterruptMs = this.opts.autoInterruptMs ?? 300_000;
  if (autoInterruptMs === 0) return undefined;
  if (!session.isPrompting) return undefined;

  // G19: require at least one touch (lastActivityAt updated after creation)
  // If promptStartedAt exists and lastActivityAt == lastResponseAt == undefined,
  // the session has never received activity — don't stall-detect yet.
  const baseline = session.promptStartedAt ?? session.lastActivityAt;
  const now = Date.now();
  const idleMs = now - baseline.getTime();

  if (idleMs > autoInterruptMs) return "stalled-prompt";
  const needsAttentionMs = this.opts.needsAttentionMs ?? 60_000;
  if (idleMs > needsAttentionMs) return "slow-prompt";
  return undefined;
}
```

**Rationale:** Use `promptStartedAt` (set by `markPromptStart`) as baseline. This means the stall clock starts when the prompt is sent, not when the session was created. If the agent is slow but working, `touch()` via `onActivity` will update `lastActivityAt` — but the stall detection should use the prompt start as the initial baseline. If no `touch()` ever arrives and `autoInterruptMs` elapses from prompt start, it IS a stall (the agent never responded).

**Alternative (simpler, pick this):** Keep using `lastActivityAt` but set it to `promptStartedAt` time in `markPromptStart`. This way the stall clock naturally starts from prompt start, and any `touch()` resets it.

```typescript
markPromptStart(sessionId: string): void {
  const entry = this.entries.get(sessionId);
  if (entry) {
    entry.session.isPrompting = true;
    entry.session.promptStartedAt = new Date();
    entry.session.lastActivityAt = entry.session.promptStartedAt;  // ← reset baseline
    entry.attentionNotified = false;
  }
}
```

**Pick this alternative.** Minimal change, reuses existing `getPromptStallReason` logic unchanged.

### G20 — Route dispose:true through closeSession

**File:** `index.ts` → `acp_prompt` execute, `dispose: true` path (~line 576)

**Change:** Replace bare `adapter.dispose()` with a proper ephemeral teardown that also cleans sessionMgr, monitor, activeAdapters:

```typescript
// BEFORE (leaks):
if (params.dispose) adapter.dispose();

// AFTER (full teardown):
if (params.dispose) {
  await closeSession(handle, 'ephemeral-dispose', false);
}
```

`closeSession` already does: `archiveSession`, `sessionMgr.remove`, `activeAdapters.delete`, `busySessions.delete`. But it does NOT call `adapter.dispose()` — we need both:

```typescript
// In closeSession, add adapter disposal OR call it before:
if (params.dispose) {
  adapter.dispose();  // kill process
  await closeSession(handle, 'ephemeral-dispose', false);  // clean registries
}
```

**Alternative:** Create a `teardownSession(handle, reason)` helper that combines `adapter.dispose()` + `closeSession()`. This is the DRY path — reuses the same teardown for G20, onStale, and shutdown.

```typescript
async function teardownSession(handle: AcpSessionHandle, reason: string): Promise<void> {
  const adapter = activeAdapters.get(handle.sessionId);
  if (adapter) adapter.dispose();
  await closeSession(handle, reason, false);
  monitor.unregister(handle.sessionId);
}
```

### G21 — Verify no metadata leak on loadSession failure (verify + test)

**File:** `index.ts` → `acp_prompt` archived-session load path (~line 530)

**Analysis:** Current code on `loadSession` throw:
1. Writes `loadStatus: "unloadable"` to archived metadata via `archiveSession(archived as AcpSessionHandle)` — this is a **metadata write to the archive store**, not a session registration.
2. Disposes the failed adapter: `adapter.dispose()`.
3. Creates a fresh adapter + fresh session → `makeSessionHandle(freshSessionId, ...)` registers the new session.

**No leak.** The failed adapter is never registered in sessionMgr/monitor/activeAdapters. The archived metadata update is intentional tracking.

**Action:** Add a vitest test that verifies: after loadSession throws, sessionMgr.size == 0 (no half-registered sessions), monitor.size == 0 (no orphan entries). Document this in the plan as verified-clean.

### G22 — DAG resume: route through makeSessionHandle or document lifecycle ownership

**File:** `src/dag/dag-executor.ts` → `resumeAll()`, and `index.ts` → startup IIFE

**Analysis:** `DagExecutor.resumeAll()` calls `coordinator.delegate()` per step. The coordinator's `delegate()` creates a **short-lived** adapter → spawn → prompt → dispose cycle. These adapters are NOT in `activeAdapters`. On shutdown, `session_shutdown` only disposes `activeAdapters`.

**Risk:** If a DAG step's adapter hangs (prompt never returns), on shutdown the adapter process survives.

**Fix (DRY):** The DagExecutor doesn't own sessions — it owns step dispatch. The coordinator's delegate creates and disposes its own adapter. The real risk is a zombie process from a hung delegate.

**Two options (pick DRY):**
- **Option A:** Have `AgentCoordinator.delegate()` register its adapter in a shared `activeAdapters` map. Requires passing `activeAdapters` to the coordinator — breaks encapsulation.
- **Option B (pick this):** Add the adapter to a `dagOwnedAdapters` set in index.ts. The startup IIFE passes a callback to the coordinator that registers/deregisters. On shutdown, dispose these too.

Actually, **simplest fix (YAGNI):** The coordinator's `delegate()` already disposes the adapter in a finally block. The only leak scenario is a hung prompt where `dispose()` is never reached. This is already mitigated by the prompt timeout (`withTimeoutMs`). After timeout, the adapter is disposed.

**Action:** Add a test that verifies coordinator.delegate() cleans up on timeout. Document that DAG steps are coordinator-owned and cleaned up via timeout + dispose. No code change needed for G22 — the existing timeout + dispose pattern is sufficient.

**If we want to be extra safe:** Add `proc.killed` check in HealthMonitor (G23 fix will cover this).

### G23 — Process liveness check in HealthMonitor (no keepalive protocol)

**File:** `src/core/health-monitor.ts`

**Change:** Add a `processLivenessCheck` option to `HealthMonitorOptions` that accepts a function `(sessionId: string) => boolean`. In `check()`, if the function returns `false`, add to stale list.

```typescript
export interface HealthMonitorOptions {
  // ... existing
  /** Check if the underlying process is still alive. Return false if dead. */
  isProcessAlive?: (sessionId: string) => boolean;
}
```

In `check()`:
```typescript
for (const id of snapshotIds) {
  const entry = this.entries.get(id);
  if (!entry) continue;

  // G23: process liveness check (cheap, no protocol)
  if (this.opts.isProcessAlive && !this.opts.isProcessAlive(id)) {
    // Process died — treat as stale
    staleIds.push(id);
    continue;
  }
  // ... existing logic
}
```

In `index.ts`, wire it:
```typescript
const monitor = new HealthMonitor({
  // ... existing
  isProcessAlive: (sessionId: string) => {
    const adapter = activeAdapters.get(sessionId);
    if (!adapter) return false;  // no adapter = not alive
    return adapter.isProcessAlive();  // new method on adapter
  },
});
```

**New method on `AcpAgentAdapter`:**
```typescript
isProcessAlive(): boolean {
  return this.client?.isProcessAlive() ?? false;
}
```

**New method on `AcpClient`:**
```typescript
isProcessAlive(): boolean {
  if (!this.proc) return false;
  if (this.proc.killed) return false;
  if (this.proc.exitCode !== null) return false;
  return true;
}
```

**Cross-plan dependency:** G3 (plan 1) adds process-group kill. G23 detects dead processes. Together: G23 detects → G17 handles cleanup → G3 ensures process groups are killed on disposal.

---

## 4. TDD Test Cases (vitest)

### test/health-monitor-g17.test.ts — onStale failure retry cap

```
- onStale failure increments staleFailureCount
- After maxStaleFailures (default 3) consecutive failures, session is force-unregistered
- Successful onStale resets staleFailureCount to 0
- Force-unregistered session is not re-detected on next check()
- maxStaleFailures option is configurable
```

### test/health-monitor-g18.test.ts — concurrent register during check

```
- register() during check() iteration does not cause entries to be missed in next cycle
- Concurrent register + check: new entry appears in subsequent check()
- Concurrent unregister + check: unregistered entry is skipped
```

### test/health-monitor-g19.test.ts — prompt stall baseline

```
- markPromptStart resets lastActivityAt to promptStartedAt
- Silent session (no touch after markPromptStart) triggers stall after autoInterruptMs from prompt start
- touch() during prompt resets stall clock
- Session with no markPromptStart but isPrompting=true does not false-positive stall
```

### test/ephemeral-dispose-g20.test.ts — dispose:true full teardown

```
- acp_prompt with dispose:true removes session from sessionMgr
- acp_prompt with dispose:true removes session from activeAdapters
- acp_prompt with dispose:true removes session from monitor
- acp_prompt with dispose:true archives session with closeReason='ephemeral-dispose'
- adapter.dispose() is called (process killed)
```

### test/load-session-failure-g21.test.ts — loadSession failure no leak

```
- After loadSession throws, sessionMgr.size == 0 for the failed session
- After loadSession throws, monitor.size does not include the failed session
- After loadSession throws, archived metadata has loadStatus='unloadable'
- Fresh fallback session is properly registered
```

### test/process-liveness-g23.test.ts — isProcessAlive integration

```
- isProcessAlive returning false adds session to stale list
- isProcessAlive returning true does not affect normal stale detection
- Dead process (proc.killed=true) is detected as stale
- Dead process (proc.exitCode !== null) is detected as stale
- isProcessAlive not configured → no liveness check (backward compatible)
```

---

## 5. Rollout / Risk

### Order of implementation

1. **G18** (snapshot keys) — trivial, zero risk, no behavior change
2. **G19** (markPromptStart resets lastActivityAt) — one-line change, fixes false positive
3. **G17** (retry cap + force-unregister) — new behavior but bounded
4. **G20** (ephemeral teardown) — fixes a real leak
5. **G23** (process liveness check) — new option, backward compatible (opt-in)
6. **G21** (verify + test only) — no code change needed
7. **G22** (document + test) — no code change needed

### Risk assessment

| Fix | Risk | Mitigation |
| --- | ---- | ---------- |
| G17 | Force-unregister may orphan session if onStale fails transiently | Cap is configurable; error is logged |
| G18 | None | Pure iteration safety |
| G19 | Slight delay in detecting truly-stalled prompts (clock starts later) | Clock starts from prompt send, which is correct |
| G20 | Double-dispose if closeSession also calls adapter.dispose | Ensure closeSession does NOT dispose adapter (current code doesn't) |
| G23 | Adapter without a process (e.g., mock) returns false → false positive | `isProcessAlive` defaults to `true` when not configured |

### Cross-plan dependencies

- **G23 ↔ Plan 1 (G3):** Process-group kill ensures dead processes are cleaned up. G23 detects them. Without G3, G23 may detect a dead process but fail to kill its process group.
- **G20 ↔ Plan 2 (teardownSession):** If plan 2 introduces a shared `teardownSession()` helper, G20 should use it.

---

## 6. OUT OF SCOPE

- **No keepalive ping protocol** between pi host and ACP children (YAGNI — process exit detection is sufficient)
- **No external watchdog process** for monitoring agent health
- **No DAG executor lifecycle integration** (G22) — coordinator delegate already handles cleanup via timeout + dispose
- **No changes to session-lifecycle.ts** — the auto-close reason logic is correct
- **No changes to AcpClient.connect/dispose** — the GAP-4 disposed guard is already robust
- **No worker session changes** — workers already have their own lifecycle (spawn/shutdown/kill/prune)

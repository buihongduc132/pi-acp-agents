# Plan — Fix Disk Bloat from Unbounded Runtime Stores (G13–G16)

Status: PLAN ONLY (no source changes). Owner: planning agent.
Scope bugs: G13, G14, G15, G16.

---

## 1. Problem (per bug)

| Bug | Store / file | Symptom |
|-----|--------------|---------|
| **G13** | `SessionArchiveStore` → `session-archive.json` | `upsert()` on every close/alive update; array grows forever. No age/count cap. |
| **G14** | `AcpEventLog` → `events.jsonl` | `appendFileSync` on every lifecycle/prompt/worker/dag event. No rotation, no size cap. Single file → unbounded. |
| **G15** | `SessionNameStore` → `session-name-registry.json` | `register()` only adds; mappings for archived/gone sessions never removed. `getSessionId()` returns dangling refs. |
| **G16** | `createFileLogger(logsDir, sessionId)` → `logsDir/{sessionId}/trace.jsonl` (+ `logsDir/main.log`) | Created per session in `client.ts ensureSessionLog`. Never deleted on close. Dir count grows with session count. |

> **Note (CA1):** G16 task brief says path is `logsDir/sessions/{sessionId}.jsonl`. **Actual** layout (`src/logger.ts`) is `logsDir/{sessionId}/trace.jsonl` (one dir + file per session) plus a shared `logsDir/main.log`. Plan targets the **actual** layout. If brief author intended a different path, confirm before implementation.

### Evidence
- [E1] `src/management/session-archive-store.ts` — `upsert()` push, no cap; `readRaw/writeRaw` full file rewrite.
- [E2] `src/management/event-log.ts` — `appendFileSync(paths.eventLogFile, …)`, single `events.jsonl`.
- [E3] `src/management/session-name-store.ts` — `register()` push, no removal path.
- [E4] `src/logger.ts` — `mkdirSync(sessionDir)` + `appendFileSync(tracePath)` per session.
- [E5] `src/core/client.ts:605` — `ensureSessionLog` called on every `newSession`; no delete on dispose/close.
- [E6] `src/core/health-monitor.ts` — existing `setInterval` tick in `HealthMonitor.start()` — natural sweep piggyback point.
- [E7] `index.ts:275` — single `HealthMonitor` instance constructed; `monitor.start()` runs the tick.

---

## 2. Root cause

No store has a `prune()` operation, and no periodic job sweeps the runtime dir.
- [C1] Stores were built append-only; cleanup was deferred (YAGNI at the time, now bite-size tech debt).
- [C2] Lifecycle hooks (`closeSession`, `dispose`) only mutate in-memory + archive metadata — never delete per-session artifacts.
- [C3] No single "housekeeping" tick exists besides `HealthMonitor`, and it only inspects live sessions.

Single shared fix: **one `prune()` per store + one sweep tick** (piggyback on HealthMonitor).

---

## 3. Solution

### 3.0 Shared helper — `src/management/prune.ts` (new, ~40 lines)

DRY home for sweep orchestration + age math. Keeps each store's `prune()` self-contained (~10 lines) — no over-engineered `Prunable` interface.

```ts
// shape only — not committed
export interface PruneResult { removed: number; }

export interface ArchivePruneOpts {
  maxAgeMs: number;     // drop sessions whose lastActivityAt older than this
  maxEntries: number;   // keep most-recent N by lastActivityAt
}
export interface NamePruneOpts {
  /** sessionIds still considered alive (skip removal) */
  knownSessionIds: ReadonlySet<string>;
}
export interface EventLogRotateOpts {
  maxSizeBytes: number;  // rotate current → .1 when exceeded
  keepFiles: number;     // retain .1 … .{keepFiles}
}
export interface SessionLogPruneOpts {
  maxAgeMs: number;      // delete session log dirs older than lastActivityAt
  knownSessionIds: ReadonlySet<string>; // keep logs for live/recently-archived sessions
}

export function days(n: number): number { return n * 86_400_000; }
```

Why a helper and not an interface: 3 stores, each ~10 lines of `prune()` body — a `Prunable` abstraction adds ceremony without reuse. Helper centralizes `days()`, age cutoff calc, and result shape only.

### 3.1 G13 — SessionArchiveStore.prune()

**Signature**
```ts
prune(opts: ArchivePruneOpts): PruneResult
```
**Logic**
1. Read payload (already does).
2. Compute cutoff = `Date.now() - opts.maxAgeMs`.
3. Filter: keep entry if `lastActivityAt >= cutoff` OR `disposed === false` (never prune live/undisposed — safety).
4. If still > `maxEntries`: sort desc by `lastActivityAt`, slice top N.
5. `writeRaw(filtered)`.
6. Return `{ removed: before - after }`.

**Config knobs (defaults)** — add to `AcpConfig` (`src/config/types.ts`):
```ts
archiveMaxAgeMs?: number;   // default days(30) = 2_592_000_000
archiveMaxEntries?: number; // default 500
```

**Safety**: `disposed === false` entries are immune to age/count pruning (live sessions never vanish).

### 3.2 G14 — AcpEventLog.rotate()

**Signature** (rename from generic `prune` since semantics differ — rotate not delete-in-place)
```ts
rotate(opts: EventLogRotateOpts): PruneResult
```
**Logic** (best-practice rotating file):
1. `statSync(current)`. If `size < maxSizeBytes` → return `{removed:0}`.
2. Delete oldest retained: `unlinkSync(events.${keepFiles}.jsonl)` if exists.
3. For `i = keepFiles-1 … 1`: `rename(events.${i}.jsonl → events.${i+1}.jsonl)`.
4. `rename(events.jsonl → events.1.jsonl)`.
5. Return `{ removed: 0 }` (rotation, no record deletion; or count rotated-out file as removed — pick `{removed:1}` to signal a rotation happened).

**Config knobs**
```ts
eventLogMaxBytes?: number; // default 10 * 1024 * 1024 (10MB)
eventLogKeepFiles?: number; // default 3
```

**Note (CA2):** `append()` already calls `ensureRuntimeDir`. `rotate()` must be cheap; only stat on each sweep tick (not every append) — see §3.5.

### 3.3 G15 — SessionNameStore.prune()

**Signature**
```ts
prune(opts: NamePruneOpts): PruneResult
```
**Logic**
1. Read mappings.
2. Keep entry iff `opts.knownSessionIds.has(sessionId)`.
3. Write if changed.
4. Return removed count.

**`knownSessionIds` source**: union of (a) live `sessionMgr.list()` ids and (b) archived session ids still in `SessionArchiveStore` post-prune. Computed by the sweep tick (§3.5) and passed in — store stays decoupled from archive.

**Config knob**: none — pruning is purely consistency-driven (name → gone session). Always-on once sweep enabled.

### 3.4 G16 — SessionLogStore (new thin wrapper) OR inline sweep in prune.ts

Two options; recommend **inline sweep in `prune.ts`** (no new class — YAGNI; logger has no store object today):
```ts
export function pruneSessionLogs(logsDir: string, opts: SessionLogPruneOpts): PruneResult
```
**Logic**
1. `readdir(logsDir)`, filter entries that are dirs matching a sessionId pattern OR `main.log`.
2. For each session dir: skip if `knownSessionIds.has(dirName)` (live/recently-archived). Else `stat` newest file inside; if mtime older than `maxAgeMs` → `rm -rf` dir.
3. Never touch `main.log` here (shared, handled by main log rotation if ever needed — out of scope).
4. Return count of dirs removed.

**Config knobs**
```ts
sessionLogMaxAgeMs?: number; // default days(14) = 1_209_600_000
```

**Safety**: only removes **directories** under `logsDir` whose name is not a known session id AND whose mtime is stale. Never removes `main.log`, never removes non-dir files at root.

### 3.5 Sweep trigger — piggyback HealthMonitor (least resistance)

**Location**: `src/core/health-monitor.ts` `start()` tick — add an optional `onSweep?: () => void | Promise<void>` to `HealthMonitorOptions`, invoked **once per N ticks** (configurable cadence) at the **end** of `check()`, non-blocking, errors swallowed + logged.

```ts
// HealthMonitorOptions additions
sweepEveryTicks?: number;  // default: Math.ceil((15*60_000)/intervalMs) → ~every 15 min at 5s tick
onSweep?: () => void | Promise<void>;
```

In `start()`'s `setInterval` body: increment `tickCount`; if `tickCount % sweepEveryTicks === 0` → `await safe(onSweep)`.

**Wiring** (`index.ts`, after `new HealthMonitor({...})` at line 275):
```ts
const archiveStore = sessionArchiveStore;        // already exists
const nameStore    = sessionNameStore;           // already exists
const evtLog       = eventLog;                   // already exists

onSweep: async () => {
  // order matters: archive first, then derive known ids
  archiveStore.prune({ maxAgeMs: cfg.archiveMaxAgeMs ?? days(30),
                       maxEntries: cfg.archiveMaxEntries ?? 500 });
  evtLog.rotate({ maxSizeBytes: cfg.eventLogMaxBytes ?? 10*1024*1024,
                  keepFiles: cfg.eventLogKeepFiles ?? 3 });
  const known = new Set<string>([
    ...sessionMgr.list().map(s => s.sessionId),
    ...archiveStore.list().map(s => s.sessionId),  // add list() to store
  ]);
  nameStore.prune({ knownSessionIds: known });
  if (config.logsDir) {
    pruneSessionLogs(config.logsDir,
      { maxAgeMs: cfg.sessionLogMaxAgeMs ?? days(14), knownSessionIds: known });
  }
}
```

**Why HealthMonitor piggyback (not new timer):**
- [A1] Avoids a second `setInterval` → one lifecycle to start/stop, one place for teardown.
- [A2] Already runs in the same process; no new cron/cron-like dep.
- [A3] `onSweep` is opt-in callback — HealthMonitor stays unaware of store specifics (no import cycle).

**Alternative considered (reject for now)**: standalone `setInterval` in `index.ts`. More code, two timers to manage, no benefit at this scale.

### 3.6 Config additions summary (all in `AcpConfig`, all optional w/ defaults)

```ts
// runtime retention
archiveMaxAgeMs?: number;     // default 30d
archiveMaxEntries?: number;   // default 500
eventLogMaxBytes?: number;    // default 10MB
eventLogKeepFiles?: number;   // default 3
sessionLogMaxAgeMs?: number;  // default 14d
sweepEveryTicks?: number;     // derived default ~15min
```

### 3.7 Store additions (minimal)
- `SessionArchiveStore`: add `prune()` + `list()` (list returns metadata array — needed to build `knownSessionIds` without re-reading private state).
- `AcpEventLog`: add `rotate()`.
- `SessionNameStore`: add `prune()`.
- `prune.ts`: `pruneSessionLogs()` + `days()` + result types.

No changes to `runtime-paths.ts` (file layout unchanged).

---

## 4. TDD test cases (vitest)

New files mirror source naming convention (`test/<store>.test.ts` already exists for name-store — extend; add `event-log.test.ts`, `session-archive-store.test.ts`, `prune.test.ts`).

### 4.1 G13 — `test/session-archive-store.test.ts`
- **T1** insert 10 entries with `lastActivityAt = now - 40d`, `disposed:true` → `prune({maxAgeMs:30d, maxEntries:500})` → 0 remain. assert `removed===10`.
- **T2** insert 10 entries, 3 with `disposed:false` (live) and old `lastActivityAt` → prune → exactly those 3 survive regardless of age. assert count==3.
- **T3** insert 600 entries all recent → `prune({maxAgeMs:30d,maxEntries:500})` → 500 remain, kept are newest by `lastActivityAt`. assert the 100 oldest dropped.
- **T4** empty store → prune → `{removed:0}`, file untouched.
- **T5** malformed JSON on disk → prune degrades (no throw), returns `{removed:0}`.

### 4.2 G14 — `test/event-log.test.ts`
- **T1** append until `events.jsonl` > 10MB → `rotate({maxSizeBytes:10MB,keepFiles:3})` → `events.jsonl` gone, `events.1.jsonl` exists with old content. assert current file absent or empty after rename.
- **T2** pre-seed `events.1.jsonl`,`events.2.jsonl`,`events.3.jsonl`; rotate → chain shifts: `.3` deleted, `.2→.3`, `.1→.2`, current→`.1`. assert `.3` is the OLD `.2`.
- **T3** file under cap → rotate → no-op, returns `{removed:0}`.
- **T4** no file exists → rotate → no-op, no throw.
- **T5** `keepFiles:1` → only `.1` retained after rotation; older unlinked.

### 4.3 G15 — `test/session-name-store.test.ts` (extend existing)
- **T1** register 3 names → `prune({knownSessionIds:new Set(['s1'])})` → only s1's mapping survives. assert `getSessionId(name2)===undefined`.
- **T2** prune with empty known set → all removed, file written empty `{mappings:[]}`.
- **T3** prune idempotent → second call `{removed:0}`.
- **T4** name registered to a known id → survives prune. assert still resolvable.

### 4.4 G16 — `test/prune.test.ts`
- **T1** create `logsDir/sA/trace.jsonl` (mtime 20d ago), `logsDir/sB/trace.jsonl` (mtime 1d ago) → `pruneSessionLogs(logsDir,{maxAgeMs:14d, known:new Set(['sB'])})` → sA dir removed, sB kept.
- **T2** stale dir BUT id in `knownSessionIds` → preserved even if old.
- **T3** `logsDir/main.log` present → never removed.
- **T4** non-dir file at `logsDir/x.json` → untouched.
- **T5** logsDir missing → no throw, `{removed:0}`.

### 4.5 Sweep integration — `test/health-monitor-sweep.test.ts`
- **T1** construct HealthMonitor with `sweepEveryTicks:2`, mock `onSweep`, call `check()` twice → onSweep called once.
- **T2** `onSweep` throws → HealthMonitor logs error, continues; next tick still runs.
- **T3** `sweepEveryTicks` undefined → default derived; assert sweep fires at expected cadence (use fake timers).

---

## 5. Rollout / Risk

### Backwards compat
- [F1] **No destructive behavior on first run without opt-in**: defaults are *retention* knobs, not deletion flags. BUT — first sweep on an existing bloated runtime WILL prune per defaults.
- **Recommendation**: ship defaults **active** (30d/500/10MB/14d). Rationale: existing users hitting disk bloat *want* cleanup; conservative defaults won't nuke recent data. Provide escape hatch:
  - `archiveMaxAgeMs: 0` → disable archive prune (documented).
  - Omit `onSweep` in HealthMonitor → sweep never runs (existing callers unaffected until they wire it).

### Risk matrix
| Risk | Mitigation |
|------|-----------|
| Prune deletes a session a user wanted to resume | `disposed===false` immunity (G13); name prune only drops names whose id is gone from *both* live + archive; logs keep recent 14d. |
| Event log rotate loses forensic data | `keepFiles:3` × 10MB = 30MB retained; tunable up. |
| Sweep blocks HealthMonitor tick | `onSweep` runs AFTER `check()`; store I/O is ms-scale for KB-MB files; errors swallowed. |
| Race: prune while `upsert` in flight | Single-process, JS event loop — no true parallelism on FS ops. Store read-modify-write already non-atomic today (pre-existing); prune adds no new race class. |
| Config migration | All knobs optional with defaults — old `config.json` works unchanged. |

### Telemetry (lightweight)
- `eventLog.append('sweep_completed', { archiveRemoved, namesRemoved, logsRemoved, rotated })` — one line per sweep, self-hosted in the rotated log.

### Rollout order
1. Land `prune.ts` + per-store `prune()/rotate()/list()` + tests (pure, no wiring) — safe merge, no behavior change.
2. Wire `onSweep` into `index.ts` HealthMonitor construction + add config knobs.
3. Document knobs in `AGENTS.md` / config types JSDoc.

---

## 6. OUT OF SCOPE

- ❌ `logrotate` / external rotation tooling.
- ❌ Database (SQLite/LevelDB) migration for stores.
- ❌ Compression of rotated event logs (`.gz`).
- ❌ `main.log` rotation (shared app log) — G16 only covers per-session `trace.jsonl` dirs.
- ❌ Pruning of `tasks.json`, `mailboxes.json`, `workers.json`, `dag/*.json` (separate bugs if filed).
- ❌ Cross-machine / multi-process locking on stores.
- ❌ Config hot-reload of retention knobs (requires restart — acceptable).
- ❌ Migration script to retroactively shrink existing bloated files (first sweep handles it).

---

## Assumptions [A]
- [A1] Single pi-acp-agents process per runtime dir (no concurrent writers) — matches current design.
- [A2] `sessionMgr.list()` exposes live session ids (verified pattern in `index.ts`).
- [A3] Vitest is the test runner (existing `test/*.test.ts` files confirm).
- [A4] Node `fs.statSync`/`readdirSync`/`renameSync`/`unlinkSync`/`rmSync` available (Node 18+, project already uses `node:fs` sync APIs in stores).
- [A5] `HealthMonitor.start()` is the only periodic tick in the runtime (verified — no other `setInterval` in `index.ts`).

## Callsout [CA]
- [CA1] G16 path mismatch: brief says `logsDir/sessions/{id}.jsonl`, actual is `logsDir/{id}/trace.jsonl`. **Confirm before impl.**
- [CA2] Event log `rotate()` triggered on sweep tick only (stat cost ~once/15min). Alternative: stat on every `append()` — rejected (hot-path I/O). If sub-15min rotation fidelity needed, lower `sweepEveryTicks`.
- [CA3] `SessionArchiveStore` currently rewrites the **entire** file on every `upsert()` — at 500 entries × frequent updates this is already wasteful; prune helps bound it but doesn't fix the rewrite cost. Future: append-only or per-session-file archive (out of scope).
- [CA4] No `Prunable` interface introduced — if a 4th store needs pruning later, revisit abstraction (YAGNI now).

_progress_place_holder

## Checklist

### Setup
- [ ] Copy the 4 plan files from `main` worktree `flow/plans/` into this worktree
- [ ] Commit _GOAL file (first-iteration rule)

### Plan 1 — Process-Level Leaks (G1–G4) → `flow/plans/fix-process-level-leaks.md`
- [ ] Process-group kill on POSIX (setsid + `kill -pgid`) in `killWithEscalation`
- [ ] Drop `timer.unref()` on SIGKILL escalation timer (or ref + await)
- [ ] Document pi-host `session_shutdown` await assumption
- [ ] TDD: vitest asserts grandchildren reaped

### Plan 2 — Dispose + Map/State Leaks (G5–G12) → `flow/plans/fix-dispose-and-map-leaks.md`
- [ ] Canonical `teardownSession(sessionId)` closes all 4 maps (activeAdapters, busySessions, workerSessionMap, monitor)
- [ ] Route closeSession / handle.dispose / worker_shutdown / worker_kill through it
- [ ] `stdin.end()` before kill (stdin EOF)
- [ ] Await dispose chain (adapter → client)
- [ ] TDD: assert all maps empty after each close path

### Plan 3 — Disk Bloat (G13–G16) → `flow/plans/fix-disk-bloat.md`
- [ ] `SessionArchiveStore.prune(maxAgeMs, maxEntries)`
- [ ] `AcpEventLog` rotating file (size cap → `.1.jsonl`, keep K)
- [ ] `SessionNameStore.prune()` — drop entries whose sessionId not in archive
- [ ] Sweep trigger (piggyback HealthMonitor interval)
- [ ] TDD: insert N old entries, prune, assert count/age

### Plan 4 — Health Monitor + Edge Cases (G17–G23) → `flow/plans/fix-health-and-edge-cases.md`
- [ ] onStale failure → unregister after N retries (cap infinite loop)
- [ ] Snapshot keys at start of `HealthMonitor.check()` (concurrent register safe)
- [ ] Stall calc uses `promptStartedAt` baseline (no false-positive on silent-working)
- [ ] Route `dispose: true` path through closeSession
- [ ] DagExecutor.resumeAll adapters tracked in activeAdapters
- [ ] Liveness check: `proc.exitCode !== null` in HealthMonitor (no keepalive protocol)
- [ ] TDD per fix

### Verification
- [ ] `npm run test -- --run` green
- [ ] 3 independent verifier-loop reviews + `claude -p` unanimous approve
- [ ] `gitnexus_detect_changes` scoped to expected symbols only

---

only update ABOVE this line. DO NOT update BELOW it.
Upon first reading this file in the iteration. MUST commit it.
Whenever update it , commit.
NEVER tamper ANYTHING AFTER this line.
KEEP the above Below 50 lines. IF more , consolidate it.

## Reference

### Plans (source of truth for each fix)
- `flow/plans/fix-process-level-leaks.md` — G1–G4 (process leaks)
- `flow/plans/fix-dispose-and-map-leaks.md` — G5–G12 (dispose + map leaks)
- `flow/plans/fix-disk-bloat.md` — G13–G16 (unbounded stores)
- `flow/plans/fix-health-and-edge-cases.md` — G17–G23 (health + edge)

### Cross-plan dependencies
- Plan 4 G23 (liveness) depends on Plan 1 G3 (process-group kill)
- Plan 4 G20 (dispose:true) shares `teardownSession()` from Plan 2

### Forensics (origin of bug list G1–G23)
- Session forensics chain: pi host `session_shutdown` → `sessionMgr.disposeAll()` → `handle.dispose()` → `adapter.dispose()` → `AcpClient.dispose()` → `killWithEscalation()`

## Goals
MUST only works in `/home/bhd/Documents/Projects/bhd/pi-acp-agents/.worktrees/fix-acp-leaks`

## Rules
- FOCUS on fixing PREVIOUS wrong / violation first before continue to the NEXT works.
- you DO NOT output <promise>COMPLETE **UNLESS**:
-- all tasks are completed
-- there are 3 independent verifier loop that review and unanimous approved and also "claude -p"

## Ceremony

### BEFORE
- check hindsight to get previous context and painpoint.
- run gitnexus to identify the impact
- pick 3 previous done items. <review>; check guard violation. THEN for any violate task. UNCHECK it.

### During. Main logic
- pick 3 next works. Do it.
TDD: implement
verify
deploy (if applied)

### AFTER. When you are about to completed your iteration
- run gitnexus to identify the impact
- MUST have the <review> approve.
- must commit.
- update progress in this file
- tell guard to enroll , find the applicable for the current project. Implement it. Report violation.

## <review>
- verifier loop & claude -p unanimous approve.

## Teams
Must have at LEAST these predefined teams spawn and working:
- verifier / verifier loop: 3 verifier.
- ops: for deployment
- tdd team.
- gorvernence.
- guard.
- ...any engineering sub agents as needed.

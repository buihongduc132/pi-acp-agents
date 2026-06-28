# Branch Consolidation — Completed 2026-06-29

## Summary

17 unmerged branches consolidated into a single PR (#12) targeting main.

### Stack (all merged via cherry-pick to `consolidate/acp-leak-and-fusion`)

```
main
 └─ fix/acp-leak-v5      (8C) idempotent handle.dispose + closeSession teardown + completedIdleTtlMs
     └─ fix/acp-leak-v8  (6C) closeSession/remove idempotency + TTL reaper convergence
         └─ fusion/fn-002 (6C) compact format acp-widget render
             ├─ fusion/fn-004 (2C) coverage tests
             ├─ fusion/fn-008 (2C) dead code removal (CB_ICON)
             └─ fusion/fn-013 (2C) lastError inline header
 └─ fix/acp-leak-cleanup (1C) plan docs (standalone)
```

### Already merged (via prior PRs)

| Branch | PR |
|--------|----|
| chore/archive-acp-persistent-workers | #4 |
| docs/scope-runtime-spec-fix | #5 |
| feat/acp-dag-delegation | #7 |
| chore/archive-acp-dag-widget | #11 |

### Dropped (subsumed)

| Branch | Reason |
|--------|--------|
| fix/acp-leak-v2 | Disposed helper, subsumed by v5 |
| fix/acp-leak-v4 | completedSessionTtlMs, subsumed by v8 |
| fix/acp-leak-v6 | Superset approach, but lacks v5's idempotent handle.dispose |
| fix/acp-leak-session-leak | Same as v5's closeSession work |
| chore/close-ca1-dag-widget-manifest | Superseded by main |

### Conflict resolutions

1. **index.ts** (v5 + v8): Combined `closeSession` (for `params.dispose`) with `scheduleCompletionClose` (for single-shot sessions). Ensures idempotency.

2. **src/acp-widget.ts** (fn-002 + main DAG): fn-002 rewrote render to compact format (231 lines). Main had DAG sections + worker rows. Merged: compact header/session rows from fn-002 + DAG sections + worker rows from main.

3. **test/acp-widget-dag-empty.test.ts**: Updated `expectedLineCount` for compact format (1 header + min(N,4) rows vs old N+5).

### Verification

- `bun run typecheck`: PASS
- `bun test` (widget/delegation/session-manager/health-monitor/dispose): ALL PASS (114 tests)
- Pre-existing env failures (spawn ENOENT, vi.hoisted) present on both main and this branch

### PR

https://github.com/buihongduc132/pi-acp-agents/pull/12

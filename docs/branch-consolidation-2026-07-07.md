# Branch Consolidation — Completed 2026-07-07

## Summary

8 branches surveyed against `main`; **1 carried real unmerged work** (merged via PR #20), the other 7 were already-merged stale refs left over from prior consolidations (notably [2026-06-29](branch-consolidation-2026-06-29.md), PRs #4/#5/#7/#11). No stacking needed — the single real branch was a clean fast-forward.

### Stack (merged via PR #20)

```
main (5e0a6f6)
 └─ fix/ast-grep-errors (1C)  resolve all 23 ast-grep error-severity violations
        → merged 888e49c (rebase FF, content preserved)
```

- **PR #20** — `fix/ast-grep-errors` → `main`, rebase-merged (clean FF, no merge commit).
- 1 commit, +150/−38 across 10 files. Adds `src/core/app-error.ts` base class; all 5 custom errors `extends AppError`. `ast-grep scan .` → **0 error-severity** violations (was 23).
- Verified 100% complete by independent verifier; GitNexus `detect_changes` confirmed no unintended symbol impact.

## Already merged / superseded — NOT re-merged (stale remote refs)

These branches showed commits "ahead of main" only because their remote refs were never deleted after their PRs merged; re-merging would **regress** main. Verified independently on 2026-07-07; cross-checked against the 2026-06-29 report.

| Branch | Tip | Real status | Evidence | Disposition |
|---|---|---|---|---|
| `feat/agent-profile-description` (local) | `4f05a17` | In main via **PR #19** | `description?` field on `AcpAgentConfig`, archive at `openspec/changes/archive/2026-07-05-agent-profile-description/` | Skip / **delete ref** |
| `origin/feat/agent-profile-description-2` | `4f05a17` | **Identical** to local dup (same 4 SHAs) | zero diff between tips | Skip / **delete ref** |
| `origin/feat/acp-dag-delegation` | `b635202` (6C) | In main via squashed **PR #7** (`f86448e`) | `git diff main..branch -- src/dag/` = **empty**; 0 unique files; 64 commits behind | Skip / **delete ref** |
| `origin/chore/archive-acp-dag-widget` | `a1942b5` | In main (PR #11); archive + `dag-monitoring/spec.md` byte-identical | main has both active + archive dirs; 59 commits behind | Skip / delete ref |
| `origin/chore/close-ca1-dag-widget-manifest` | `57a26af` | CA1 note already in main (`state.json`) | 60 commits behind; strictly-older manifest | Skip / delete ref |
| `origin/docs/scope-runtime-spec-fix` | `e755ca8` | In main via **PR #5** | 4+3 split spec **byte-identical** in main's archived + promoted copies; commit touches **0 `src/`** files (the +1860/−26553 diff was the 71-commit merge-base gap) | **Abandon** / delete ref |
| `origin/chore/archive-acp-persistent-workers` | `d56a080` (2C) | ⚠️ **REGRESSION** — in main via **PR #4**, but branch base is 73 commits behind and **predates DAG entirely** | `git show d56a080` confirms it would delete `src/dag/{dag-executor,dag-store,dag-validator,template-resolver}.ts`, panels, persona (−3153 src lines) | **ABANDON** / delete ref |

### Key false-alarm defused

`v-ast-grep` flagged `archive-acp-persistent-workers` **and** `scope-runtime-spec-fix` as "deletes `dag-executor.ts`". For `scope-runtime-spec-fix` this was a **merge-base artifact** (`git diff main..branch` spans a stale base; the actual commit `e755ca8` touches only 4 openspec docs). For `archive-acp-persistent-workers` it was **real** (the branch genuinely predates DAG). Lesson: distinguish via `git show <tip> --name-status` (the commit), not `git diff main..branch` (the base gap).

## 80–99% branches

None. `fix/ast-grep-errors` was 100%; every other branch was 0% useful (already merged). No completion or re-verification work was required.

## Recommended follow-up

Delete the 6 stale remote refs above (especially `origin/chore/archive-acp-persistent-workers`, which is a regression hazard if anyone re-opens it):

```
git push origin --delete feat/agent-profile-description-2 \
                     feat/acp-dag-delegation \
                     chore/archive-acp-dag-widget \
                     chore/close-ca1-dag-widget-manifest \
                     docs/scope-runtime-spec-fix \
                     chore/archive-acp-persistent-workers
```

Local `feat/agent-profile-description` can be dropped with `git branch -D feat/agent-profile-description`.

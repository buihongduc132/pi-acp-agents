# Run Audit

- **Spec contradiction fix merged via:** PR #5 (squash) → https://github.com/buihongduc132/pi-acp-agents/pull/5
- **Merge SHA:** e453b99
- **What:** Resolved 3 spec-internal contradictions (P1 spec, P2 design, P2 proposal) to align all artifacts to "4 session-scoped + 3 global stores" design intent.
- **Orchestration:** openspec-apply-ops iteration (archon-configuration worktree `.pi-wt-openspec-apply-ops`)
- **_GOAL:** `_GOAL_openspec_apply.md`
- **Date:** 2026-06-20

## Implementation status (NOT yet applied — separate impl pass required)
The actual code implementation is a **half-done refactor** sitting uncommitted in the working tree:
- ✅ DONE: store constructors require sessionId (tasks 2.1, 2.2); runtime-paths.ts splits session-scoped vs global paths; session-store-factory.ts + legacy-migration.ts exist (tasks 1.x, 2.x, 4.x).
- ❌ NOT DONE: index.ts wiring still creates stores WITHOUT sessionId → would throw at runtime (task 3.1/3.2/3.3); 87 tests fail because they construct stores without sessionId (task 5.1); SessionArchiveStore impl is session-scoped but spec now says GLOBAL — needs reverting to global.
- `openspec validate` passes; `openspec status` shows 0/24 tasks checked.

## Next pickup
Complete the impl: (1) make SessionArchiveStore global per corrected spec, (2) rewire index.ts to use SessionStoreFactory.get(sessionId), (3) fix 87 failing tests to pass sessionId, (4) check off tasks, (5) PR + merge.

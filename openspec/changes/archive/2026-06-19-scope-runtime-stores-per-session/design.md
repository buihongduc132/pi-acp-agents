## Context

Today, every ACP store class (`src/management/*.ts`) reads/writes a flat file set under `~/.pi/acp-agents/runtime/`. The `rootDir` parameter exists but is optional and tests pass `undefined` for it; production wiring (`index.ts`) also passes nothing, so all stores share one global directory. The store classes themselves never reference session ID or cwd — they only know about the root dir. `session-archive-store.ts` records `cwd` and `sessionId` as data fields per record but does not partition by them.

Stakeholders: any pi session that spawns ACP workers (the entire pi-acp-agents user base). Constraint: must not silently drop existing data on upgrade.

## Goals / Non-Goals

**Goals:**
- Partition every runtime store by session ID so two concurrent sessions cannot see each other's tasks, mailboxes, workers, or governance.
- Keep the public tool surface (`acp_task_*`, `acp_message_*`, etc.) unchanged for callers — scoping is internal.
- Provide a non-destructive migration for existing flat-layout data.
- Preserve the `rootDir` test override mechanism.

**Non-Goals:**
- Cross-session queries or admin tooling (explicit opt-in for a later change).
- CWD-level sub-scoping inside a session (session ID is the partition boundary; cwd stays as a record field).
- Splitting the session-archive or session-name-registry (they remain global catalogs of sessions — they index sessions, not session-scoped data).
- Distributed / multi-machine scoping (single machine assumption unchanged).

## Decisions

**Decision 1 — Session ID is the partition key, not cwd.**
- *Why*: Session ID uniquely identifies a pi session lifetime. cwd can collide across sessions (two terminals in the same repo). Workers belong to a session, not a cwd.
- *Alternatives considered*: (a) cwd-based partitioning — rejected, collisions + a session spanning two cwds would split its own state. (b) (sessionId, cwd) composite — rejected, adds complexity with no real isolation benefit since session ID is already unique.

**Decision 2 — Session archive + session-name-registry stay GLOBAL.**
- *Why*: These stores catalog sessions themselves. They are the index, not session-scoped data. Partitioning them by session ID would make them useless (each session only sees itself).
- *Alternative considered*: Move them too — rejected, breaks the "list all sessions" use case that `acp_session_list` depends on.

**Decision 3 — Path layout: `<root>/<sessionId>/` with `legacy/` sibling.**
- *Why*: Flat one-level nesting keeps path depth shallow and makes per-session cleanup trivial (`rm -rf <sessionId>/`). Putting `legacy/` as a sibling of session dirs (not under any session) avoids accidental capture.
- *Layout*:
  ```
  ~/.pi/acp-agents/runtime/
  ├── ses_abc123/
  │   ├── tasks.json
  │   ├── mailboxes.json
  │   ├── governance.json
  │   └── workers.json
  ├── ses_def456/
  │   └── ...
  ├── legacy/                     # migrated flat-layout files
  │   ├── tasks.json
  │   └── ...
  ├── session-name-registry.json  # GLOBAL — catalogs all sessions
  ├── session-archive.json        # GLOBAL — catalogs/archives sessions themselves
  └── events.jsonl                # GLOBAL audit trail (append-only across sessions)
  ```

**Decision 4 — `sessionId` becomes a required constructor param on the 4 session-scoped stores; the 3 global stores keep their current signature.**
- *Stores that gain `sessionId`* (4): AcpTaskStore, MailboxManager, GovernanceStore, WorkerStore.
- *Stores that stay as-is* (3): SessionNameStore (global registry), SessionArchiveStore (global session catalog), AcpEventLog (global append-only audit).
- *Why split*: A per-session event log would lose audit value; a per-session name registry is contradictory; the session-archive catalogs sessions themselves (it is the index, not session-scoped data). All three stay global.
- *Throw on missing*: Session-scoped stores constructed without `sessionId` throw synchronously — no silent global fallback (the original footgun).

**Decision 5 — Migration runs once at coordinator boot, before any store is opened.**
- *Why*: If migration raced with store reads, a session could read stale flat data. Running migration atomically up-front (move files into `legacy/`) guarantees all subsequent store opens see the new layout.
- *Idempotent*: Migration checks for the presence of flat files at root; if none, no-op.

## Risks / Trade-offs

- **[Risk] Lost tasks if user runs new binary, then rolls back to old binary** → Mitigation: old binary reads flat layout; new binary moved flat → `legacy/`. Rollback path: copy `legacy/*` back to root. Documented in tasks.md.
- **[Risk] Store consumers forget to pass `sessionId` at construction** → Mitigation: TypeScript makes it required; runtime throws on missing. Tests will fail loud.
- **[Risk] Concurrent migration races if two sessions boot at once after upgrade** → Mitigation: use atomic `rename()` (filesystem-level atomic on same filesystem) and guard with a `legacy/.migrating` marker file checked first.
- **[Trade-off] Disk usage grows linearly with number of sessions** → Acceptable: files are small JSON; old session dirs can be pruned via existing `acp_prune` semantics (extend it to remove session dirs past staleness threshold).
- **[Trade-off] No cross-session view** → Out of scope; admin tooling can read directories directly if needed.

## Migration Plan

1. Ship new binary that knows the new layout.
2. On first coordinator boot in any session, run `migrateLegacyLayout(root)`:
   - If `legacy/` already exists, skip.
   - Else, for each known session-scoped flat file (`tasks.json`, `mailboxes.json`, `governance.json`, `workers.json`): if present at root, `rename()` into `legacy/`.
   - Leave `session-name-registry.json`, `session-archive.json`, and `events.jsonl` at root (all three are GLOBAL — they catalog/audit sessions themselves, per Decision 2).
3. Proceed with normal session-scoped store construction.
4. Rollback: stop new binary, copy `legacy/*.json` back to root, start old binary.

## Open Questions

- Should `acp_prune` gain a `--sessions` mode that removes whole session dirs past a staleness threshold? (Tentative: yes, but defer to a follow-up change to keep this one focused.)
- RESOLVED: session-archive store stays GLOBAL (per Decision 2 and spec line 6). Confirmed against `acp_session_list`, which must see all sessions — partitioning the archive by session would break cross-session listing.

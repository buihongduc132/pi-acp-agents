## Why

All ACP runtime stores (tasks, mailboxes, governance, workers, event log) currently live as flat files in a single shared directory (`~/.pi/acp-agents/runtime/`). Every pi session on the machine shares the same task pool, mailbox pool, worker list, and governance state. This causes cross-session contamination: a worker spawned from session A can claim a task created in session B; mailboxes leak across sessions; governance rules apply globally instead of per-session. Task isolation is a correctness requirement, not a feature request.

## What Changes

- **BREAKING**: Runtime stores are now partitioned per ACP session. Each session gets its own directory under `~/.pi/acp-agents/runtime/<session-id>/`.
- All store classes (`AcpTaskStore`, `MailboxManager`, `GovernanceStore`, `WorkerStore`, `SessionArchiveStore`, `SessionNameStore`, `EventLog`) accept a mandatory `sessionId` parameter that scopes their file paths.
- `getRuntimePaths()` derives a per-session subdirectory from the `sessionId`.
- Migration: existing unscoped files (`tasks.json`, `mailboxes.json`, etc.) are auto-migrated into a `legacy/` subdirectory on first session boot, then cleared from the root.
- New capability: `acp_task_list`, `acp_message_list`, etc. now operate within the caller's session scope by default. Cross-session queries (if needed later) can be added as explicit opt-in.

## Capabilities

### New Capabilities
- `session-scoped-stores`: Runtime store directory layout and all store classes partitioned by session ID. Covers path derivation, constructor changes, and migration from flat layout.

### Modified Capabilities
<!-- None — no existing specs yet. -->

## Impact

- **Code**: `src/management/runtime-paths.ts` (path derivation), all 7 store classes under `src/management/`, `src/index.ts` / adapter wiring (pass `sessionId` on construction), tests.
- **APIs**: Public tool surface (`acp_task_*`, `acp_message_*`, etc.) unchanged for callers — scoping is internal. But stored data is now session-isolated.
- **Migration**: Existing `~/.pi/acp-agents/runtime/*.json` files must be relocated on first boot after upgrade. Non-destructive — move to `legacy/` subdirectory.
- **Tests**: All existing store tests that construct stores without `sessionId` must be updated. New tests for per-session isolation.
- **Dependencies**: None external. Internal change only.

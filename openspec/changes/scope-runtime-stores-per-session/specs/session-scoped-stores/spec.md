## ADDED Requirements

### Requirement: Stores partitioned by ACP session
All runtime store classes (task, mailbox, governance, worker, session-archive, session-name-registry, event-log) SHALL scope their persisted files by the ACP session ID of the caller. Each session SHALL have its own directory subtree. Data written by one session SHALL NOT be visible to another session's store instance.

#### Scenario: Two sessions get isolated task stores
- **WHEN** session A and session B each instantiate `AcpTaskStore` with their respective session IDs
- **THEN** a task created by session A SHALL NOT appear in session B's `acp_task_list` output

#### Scenario: Worker auto-claim stays in session scope
- **WHEN** a worker spawned from session A calls `claimNextAvailable`
- **THEN** it SHALL only consider tasks created within session A's task store, never tasks from other sessions

#### Scenario: Mailbox messages stay in session scope
- **WHEN** session A sends a mailbox message via `acp_message_send`
- **THEN** the message SHALL only be visible to workers within session A's mailbox store

### Requirement: Session-scoped path derivation
The runtime paths helper SHALL derive a per-session base directory from the session ID. The directory layout SHALL be `~/.pi/acp-agents/runtime/<session-id>/` and all store files SHALL be created under that directory.

#### Scenario: Paths include session ID segment
- **WHEN** `getRuntimePaths` is called with session ID `ses_abc123`
- **THEN** `tasksFile` SHALL resolve to `~/.pi/acp-agents/runtime/ses_abc123/tasks.json` (or the equivalent configured root)

#### Scenario: Session ID is mandatory at store construction
- **WHEN** a store class is constructed without a session ID
- **THEN** construction SHALL throw an explicit error (no silent fallback to a global pool)

### Requirement: Legacy flat layout migration
On first boot after upgrade, the system SHALL detect legacy flat files at the runtime root (`~/.pi/acp-agents/runtime/tasks.json`, `mailboxes.json`, etc.) and relocate them to a `legacy/` subdirectory. Migration SHALL be non-destructive (move, not delete). Migration SHALL be idempotent — running twice SHALL be a no-op.

#### Scenario: Legacy files relocated on first boot
- **WHEN** the runtime boots and finds `tasks.json` at the runtime root
- **THEN** the file SHALL be moved to `~/.pi/acp-agents/runtime/legacy/tasks.json` before any per-session directory is created

#### Scenario: Re-running migration is safe
- **WHEN** migration runs a second time after the first migration completed
- **THEN** it SHALL detect that no legacy files remain and exit without error

### Requirement: Backwards-compatible explicit root override
The existing `rootDir` constructor parameter SHALL remain supported for testing and override scenarios. When provided, it SHALL replace the `~/.pi/acp-agents/runtime/` base but the session ID segment SHALL still be appended.

#### Scenario: Test override still isolates by session
- **WHEN** a test constructs `AcpTaskStore` with `rootDir=/tmp/test-runtime` and `sessionId=ses_x`
- **THEN** the tasks file SHALL be written to `/tmp/test-runtime/ses_x/tasks.json`

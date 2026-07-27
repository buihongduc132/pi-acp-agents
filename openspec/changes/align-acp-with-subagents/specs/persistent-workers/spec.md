## MODIFIED Requirements

### Requirement: Live Steer Injection

The system SHALL provide `acp_worker_steer({ name, message })` that injects a message into a worker's **active** ACP turn. If the agent has an in-flight turn, the system SHALL attempt a native provider-specific interrupt (e.g., ACP `session/prompt` with high-priority flag). If no in-flight turn exists, the system SHALL queue the steer as a prefix to the next prompt the dispatcher issues.

**Additionally**, the system SHALL support steer injection via `acp_msg({ action: "send", session_id, message, kind: "steer" })` for workers that are part of an async run (spawned with `acp_spawn({ async: true })`). The steer SHALL be delivered to the worker's session regardless of whether it was spawned via `acp_worker_spawn` or `acp_spawn`.

#### Scenario: Steer an in-flight worker
- **WHEN** a worker has `status: "busy"` (in-flight ACP turn) and the LLM calls `acp_worker_steer({ name: "verifier-1", message: "Focus on edge cases first" })`
- **THEN** the system SHALL attempt to interrupt the active session with the steer message (provider-specific); if the provider supports interruption, the agent SHALL receive the steer mid-turn; if not, the system SHALL return a warning: `"Provider does not support live interrupt; steer queued for next prompt"`

#### Scenario: Steer an idle worker
- **WHEN** a worker has `status: "idle"` and the LLM calls `acp_worker_steer({ name: "verifier-1", message: "Prioritize security checks" })`
- **THEN** the system SHALL queue the steer message and prepend it to the next task prompt the dispatcher issues to this worker

#### Scenario: Steer a non-existent worker
- **WHEN** the LLM calls `acp_worker_steer({ name: "non-existent", message: "..." })`
- **THEN** the system SHALL return an error: `"Worker 'non-existent' not found"`

#### Scenario: Steer via acp_msg for async-spawned worker
- **WHEN** a worker was spawned via `acp_spawn({ async: true, name: "worker-1" })` and the LLM calls `acp_msg({ action: "send", session_id: "<sessionId>", message: "Focus on tests", kind: "steer" })`
- **THEN** the system SHALL deliver the steer to the worker's session using the same interrupt-or-queue logic as `acp_worker_steer`
- **AND** the steer SHALL be visible in the worker's telemetry (e.g., `steersReceived: 1`)

## ADDED Requirements

### Requirement: Per-worker worktree isolation

`acp_worker_spawn({ ..., worktree: true })` SHALL create an isolated git worktree for the worker, scoped under the project's worktree directory, with the worker's `cwd` set to the worktree path. The worktree SHALL be removed when the worker shuts down unless `keepWorktree: true` is set.

#### Scenario: Spawn worker with isolated worktree
- **WHEN** the LLM calls `acp_worker_spawn({ name: "worker-1", agent: "general", worktree: true })` from cwd `/project`
- **THEN** the system SHALL create a new git worktree at `/project/.worktrees/worker-1` (or the configured worktree dir), set the worker's `cwd` to that path, and return the worktree path in the spawn response
- **AND** the worker's ACP session SHALL execute in the isolated worktree

#### Scenario: Worktree cleanup on shutdown
- **WHEN** a worker with `worktree: true` shuts down (graceful or force) and `keepWorktree` was not set
- **THEN** the system SHALL remove the git worktree and SHALL delete the worktree directory
- **AND** any uncommitted changes in the worktree SHALL be lost (no auto-commit)

#### Scenario: Shared cwd when worktree omitted
- **WHEN** the LLM calls `acp_worker_spawn` without `worktree` or with `worktree: false`
- **THEN** the worker SHALL execute in the parent's cwd, with no worktree creation or cleanup

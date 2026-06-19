## ADDED Requirements

### Requirement: Worker Identity

A worker SHALL be identified by a unique `name` (string, 1-64 chars, alphanumeric + hyphens + underscores) and bound to a long-lived ACP session. The system SHALL register the worker in `WorkerStore` with fields `{ name, agentName, sessionId, status, spawnedAt, lastActivityAt }`. The system SHALL reject duplicate names with a clear error.

#### Scenario: Spawn a new worker
- **WHEN** the LLM calls `acp_worker_spawn({ name: "verifier-1", agent: "gemini", cwd: "/project" })`
- **THEN** the system SHALL create a new ACP session via `SessionManager`, register the worker in `WorkerStore` with `status: "online"`, and return the `sessionId`
- **AND** the worker SHALL be addressable by `name` for subsequent `acp_prompt`, `acp_worker_steer`, `acp_worker_shutdown` calls

#### Scenario: Attempt duplicate name
- **WHEN** the LLM calls `acp_worker_spawn({ name: "verifier-1", ... })` and a worker named `"verifier-1"` already exists in `WorkerStore`
- **THEN** the system SHALL return an error: `"Worker 'verifier-1' already exists"` and SHALL NOT create a new session

#### Scenario: Worker persists across task completions
- **WHEN** a worker completes a task via `WorkerDispatcher`
- **THEN** the worker's ACP session SHALL remain alive (not disposed), the worker's `status` SHALL return to `"idle"`, and the worker SHALL be eligible to claim the next unblocked task

### Requirement: Background Auto-Claim Dispatch

The system SHALL run a `WorkerDispatcher` loop that periodically (default: 5s) checks for idle workers and unblocked tasks. When both exist, the system SHALL automatically claim the task and dispatch it to the worker via `acp_prompt`. The system SHALL use `AcpTaskStore.claimNextAvailable()` to select the next unblocked, unassigned, non-completed task.

#### Scenario: Idle worker claims unblocked task
- **WHEN** a worker has `status: "idle"` and `AcpTaskStore` contains an unblocked task with no assignee
- **THEN** within 5s (configurable via `workerClaimIntervalMs`), the system SHALL call `claimNextAvailable()`, assign the task to the worker, build a task prompt (mirror `teams/worker.ts:buildTaskPrompt`), call `acp_prompt` on the worker's session, and update the worker's `status` to `"busy"`

#### Scenario: Multiple idle workers compete for tasks
- **WHEN** two workers have `status: "idle"` and `AcpTaskStore` contains two unblocked tasks
- **THEN** the system SHALL dispatch each task to a different worker (round-robin or FIFO by worker registration order) and SHALL NOT assign both tasks to the same worker

#### Scenario: No unblocked tasks available
- **WHEN** a worker has `status: "idle"` but `AcpTaskStore.claimNextAvailable()` returns `null` (no unblocked tasks)
- **THEN** the worker SHALL remain `"idle"`, and the dispatcher SHALL retry on the next interval (5s later)

#### Scenario: Disable auto-claim
- **WHEN** the configuration sets `workerAutoClaim: false`
- **THEN** the `WorkerDispatcher` SHALL NOT run, and workers SHALL only receive tasks via explicit `acp_prompt` calls

### Requirement: Live Steer Injection

The system SHALL provide `acp_worker_steer({ name, message })` that injects a message into a worker's **active** ACP turn. If the agent has an in-flight turn, the system SHALL attempt a native provider-specific interrupt (e.g., ACP `session/prompt` with high-priority flag). If no in-flight turn exists, the system SHALL queue the steer as a prefix to the next prompt the dispatcher issues.

#### Scenario: Steer an in-flight worker
- **WHEN** a worker has `status: "busy"` (in-flight ACP turn) and the LLM calls `acp_worker_steer({ name: "verifier-1", message: "Focus on edge cases first" })`
- **THEN** the system SHALL attempt to interrupt the active session with the steer message (provider-specific); if the provider supports interruption, the agent SHALL receive the steer mid-turn; if not, the system SHALL return a warning: `"Provider does not support live interrupt; steer queued for next prompt"`

#### Scenario: Steer an idle worker
- **WHEN** a worker has `status: "idle"` and the LLM calls `acp_worker_steer({ name: "verifier-1", message: "Prioritize security checks" })`
- **THEN** the system SHALL queue the steer message and prepend it to the next task prompt the dispatcher issues to this worker

#### Scenario: Steer a non-existent worker
- **WHEN** the LLM calls `acp_worker_steer({ name: "non-existent", message: "..." })`
- **THEN** the system SHALL return an error: `"Worker 'non-existent' not found"`

### Requirement: Heartbeat and Staleness Detection

The system SHALL track `lastActivityAt` on the worker record by updating it on every ACP `session/update` event (token delta, tool call, text). The system SHALL derive worker status as:
- `online` — activity within last 60s (configurable `workerOnlineMs`)
- `idle` — no in-flight task, activity within 60s
- `busy` — in-flight task
- `stale(<age>s)` — no activity for > 60s (configurable `workerStaleMs`)

Stale workers SHALL be surfaced in `acp_worker_list` but SHALL NOT be auto-killed.

#### Scenario: Worker receives session/update events
- **WHEN** a worker's ACP session emits `session/update` events (tokens, tool calls, text)
- **THEN** the system SHALL update the worker's `lastActivityAt` to `now` on each event

#### Scenario: Worker becomes stale
- **WHEN** a worker has no `session/update` events for > 60s
- **THEN** `acp_worker_list` SHALL report the worker's status as `stale(65s)` (or similar age indicator)

#### Scenario: Stale worker is not auto-killed
- **WHEN** a worker has `status: stale`
- **THEN** the system SHALL NOT automatically kill or dispose the worker; the LLM SHALL decide whether to call `acp_worker_prune` or `acp_worker_kill`

### Requirement: Graceful and Force Lifecycle Control

The system SHALL provide `acp_worker_shutdown({ name | all })` for graceful shutdown: wait up to `workerShutdownTimeoutMs` (default 30s) for the current turn to finish, persist task state (incomplete task → `status: "pending"`), dispose the ACP session, and mark the worker `offline`. The system SHALL provide `acp_worker_kill({ name })` for force kill: immediate SIGTERM→SIGKILL dispose, unassign active tasks. The system SHALL provide `acp_worker_prune()` to mark all stale workers `offline` and unassign their tasks.

#### Scenario: Graceful shutdown of idle worker
- **WHEN** the LLM calls `acp_worker_shutdown({ name: "verifier-1" })` and the worker has `status: "idle"`
- **THEN** the system SHALL immediately dispose the ACP session, mark the worker `offline` in `WorkerStore`, and return success

#### Scenario: Graceful shutdown of busy worker
- **WHEN** the LLM calls `acp_worker_shutdown({ name: "verifier-1" })` and the worker has `status: "busy"`
- **THEN** the system SHALL wait up to 30s (configurable `workerShutdownTimeoutMs`) for the turn to finish; if the turn completes within the timeout, the system SHALL persist the task result (if any), dispose the session, and mark the worker `offline`; if the turn does not complete within the timeout, the system SHALL return an error: `"Shutdown timed out; worker 'verifier-1' still busy. Use acp_worker_kill to force."`

#### Scenario: Force kill a stuck worker
- **WHEN** the LLM calls `acp_worker_kill({ name: "verifier-1" })`
- **THEN** the system SHALL immediately SIGTERM→SIGKILL the ACP session process, unassign any active tasks (set `status: "pending"`), mark the worker `offline`, and return success

#### Scenario: Prune all stale workers
- **WHEN** the LLM calls `acp_worker_prune()`
- **THEN** the system SHALL find all workers with `status: stale`, unassign their active tasks, mark them `offline`, and return a list of pruned worker names

### Requirement: Liveliness Status Surfacing

The system SHALL provide `acp_worker_list` that returns a list of all workers with their status, liveliness counters, and last-activity age. For each worker, the system SHALL display: `tok=<n> · tools=<n> · <age>s ago`, where `tok` is the cumulative `tokensIn + tokensOut` from `session/update` deltas, `tools` is the count of tool calls, and `<age>` is `now - lastActivityAt` in seconds. If all three signals are frozen for > `stallTimeoutMs` (existing config), the system SHALL render `⚠ stale`.

#### Scenario: Worker with active session
- **WHEN** a worker has received 500 tokens in, 300 tokens out, made 3 tool calls, and had its last activity 10s ago
- **THEN** `acp_worker_list` SHALL report: `"verifier-1: tok=800 · tools=3 · 10s ago"`

#### Scenario: Stale worker detection
- **WHEN** a worker has not received any `session/update` events for > 1 hour (existing `stallTimeoutMs`)
- **THEN** `acp_worker_list` SHALL render: `"verifier-1: tok=0 · tools=0 · 3600s ago ⚠ stale"`

#### Scenario: Worker not found
- **WHEN** the LLM calls `acp_worker_list` and `WorkerStore` contains no workers
- **THEN** the system SHALL return an empty list with message: `"No workers found"`

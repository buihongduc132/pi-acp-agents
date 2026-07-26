## ADDED Requirements

### Requirement: Async spawning returns run id immediately

The system SHALL accept `acp_spawn({ ..., async: true })` and return `{ runId, status: "prompting" }` immediately, with the prompt executing in the background. The synchronous one-shot path (`async` omitted or `false`) SHALL remain as the legacy fire-and-forget lane with no run id.

#### Scenario: Spawn async returns run id
- **WHEN** the LLM calls `acp_spawn({ agent: "general", prompt: "Write tests", async: true })`
- **THEN** the system SHALL return `{ runId: "<uuid>", status: "prompting" }` within 100ms and SHALL NOT block on the prompt execution
- **AND** the prompt SHALL be processed in the background, with state transitions visible via `acp_status({ id: "<uuid>" })`

#### Scenario: Sync spawn stays one-shot
- **WHEN** the LLM calls `acp_spawn({ agent: "general", prompt: "Hi" })` without `async`
- **THEN** the system SHALL block until the response is received and return the response inline, with no `runId` exposed
- **AND** no entry SHALL be created in the async run registry

### Requirement: Per-run status telemetry

`acp_status({ action: "status", id: "<runId>" })` SHALL return `{ state, turns, toolCalls, tokensUsed, lastActivityAt, outputPath, error? }`. The `state` field SHALL be one of: `prompting`, `running`, `needs-attention`, `completed`, `failed`. Telemetry SHALL update at least every 5 seconds while the run is active.

#### Scenario: Query active run
- **WHEN** the LLM calls `acp_status({ id: "<runId>" })` on a run that is mid-execution
- **THEN** the system SHALL return the current `state`, cumulative `turns`, `toolCalls`, `tokensUsed`, and `lastActivityAt` timestamp
- **AND** the response SHALL include `outputPath` pointing to the run's output log

#### Scenario: Query completed run
- **WHEN** the LLM calls `acp_status({ id: "<runId>" })` on a completed run
- **THEN** the system SHALL return `{ state: "completed", turns, toolCalls, tokensUsed, outputPath, completedAt }`
- **AND** subsequent calls SHALL return the same values (immutable terminal state)

### Requirement: Fleet view lists all active runs

`acp_status({ view: "fleet" })` SHALL return a compact list of every active async run with `runId`, `state`, `lastActivityAt`, and per-run summary. Inactive runs older than the retention window (default 24h) SHALL be excluded.

#### Scenario: List active runs
- **WHEN** the LLM calls `acp_status({ view: "fleet" })` while three async runs are active
- **THEN** the system SHALL return an array of three entries, each with `{ runId, state, agent, lastActivityAt, summary }`
- **AND** entries SHALL be sorted by `lastActivityAt` descending

#### Scenario: No active runs
- **WHEN** the LLM calls `acp_status({ view: "fleet" })` with no active runs
- **THEN** the system SHALL return `{ runs: [], message: "no active async runs" }`

### Requirement: Live steer injection into async run

`acp_msg({ action: "send", session_id: "<asyncSessionId>", message: "...", kind: "steer" })` SHALL inject a message into the async run's active turn if one exists. If no active turn, the message SHALL be queued as a follow-up that runs after the current turn completes. Steer SHALL NOT dispose the session.

#### Scenario: Steer in-flight async run
- **WHEN** an async run has an active turn and the LLM calls `acp_msg({ action: "send", session_id, message: "Focus on edge cases", kind: "steer" })`
- **THEN** the system SHALL attempt a provider-specific interrupt and deliver the steer mid-turn
- **AND** if the provider does not support interrupt, the system SHALL return `{ delivered: false, queued: true, reason: "no-interrupt-support" }`

#### Scenario: Steer queued when no active turn
- **WHEN** an async run is between turns and the LLM sends a steer
- **THEN** the system SHALL queue the steer as a follow-up prefix and SHALL return `{ delivered: true, queued: true }`

### Requirement: Interrupt and resume control

`acp_status({ action: "interrupt", id })` SHALL abort the in-flight turn of an async run and leave the run in `state: "needs-attention"`. `acp_status({ action: "resume", id, message })` SHALL revive a paused/completed/failed async run with new guidance, transitioning back to `state: "running"`.

#### Scenario: Interrupt an async run
- **WHEN** the LLM calls `acp_status({ action: "interrupt", id: "<runId>" })` on a running async run
- **THEN** the system SHALL abort the in-flight turn, transition `state` to `"needs-attention"`, and preserve all telemetry accumulated so far

#### Scenario: Resume a paused run
- **WHEN** the LLM calls `acp_status({ action: "resume", id: "<runId>", message: "Continue from step 3" })` on a paused run
- **THEN** the system SHALL re-engage the session with the resume message, transition `state` to `"running"`, and continue telemetry accumulation from the prior totals

#### Scenario: Resume a failed run
- **WHEN** the LLM calls `acp_status({ action: "resume", id: "<runId>", message: "Retry" })` on a run that failed with a rate-limit error
- **THEN** the system SHALL re-spawn or re-engage the session and SHALL NOT require a fresh `acp_spawn` call

### Requirement: Per-run worktree isolation

`acp_spawn({ ..., worktree: true })` SHALL create an isolated git worktree for the run, scoped under the project's worktree directory, with the run's `cwd` set to the worktree path. The worktree SHALL be removed when the run disposes unless `keepWorktree: true` is set.

#### Scenario: Spawn with isolated worktree
- **WHEN** the LLM calls `acp_spawn({ agent: "general", prompt: "...", worktree: true })` from cwd `/project`
- **THEN** the system SHALL create a new git worktree at `/project/.worktrees/acp-<runId>` (or the configured worktree dir), set the run's `cwd` to that path, and return the worktree path in the spawn response

#### Scenario: Worktree cleanup on dispose
- **WHEN** an async run with `worktree: true` disposes (completed or failed) and `keepWorktree` was not set
- **THEN** the system SHALL remove the git worktree and SHALL delete the worktree directory

#### Scenario: Shared cwd when worktree omitted
- **WHEN** the LLM calls `acp_spawn` without `worktree` or with `worktree: false`
- **THEN** the run SHALL execute in the parent's cwd, with no worktree creation or cleanup

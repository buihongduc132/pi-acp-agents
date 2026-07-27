## ADDED Requirements

### Requirement: Silent-completion detection for async runs

When an async run's ACP session reports a terminal state (`completed-oneshot` or `completed`) and the run produced zero file writes AND zero tool calls during its lifetime, the system SHALL mark the run as `state: "failed"` with `error.reason: "silent-no-output"` instead of `completed`. The detection SHALL run within 1 second of the terminal session event.

#### Scenario: One-shot session completes without output
- **WHEN** an async run's session transitions to `completed-oneshot` and the run's telemetry shows `toolCalls: 0` and `filesWritten: 0`
- **THEN** the run state SHALL be set to `"failed"` with `error.reason: "silent-no-output"`
- **AND** the run's `outputPath` SHALL contain a diagnostic note explaining the silent completion

#### Scenario: Session with tool calls is not silent
- **WHEN** an async run's session transitions to `completed` and the run made at least one tool call (e.g., `bash`, `write`, `edit`)
- **THEN** the run state SHALL remain `"completed"` and SHALL NOT trigger silent-failure detection

#### Scenario: Session with file writes is not silent
- **WHEN** an async run's session transitions to `completed` and the run wrote at least one file to its worktree
- **THEN** the run state SHALL remain `"completed"` even if `toolCalls` was zero (some agents write via non-tool paths)

### Requirement: Silent failure surfaces in fleet view and notifications

Silent-failure runs SHALL be visible in `acp_status({ view: "fleet" })` with their `error.reason` shown, and SHALL trigger a wake notification to the parent session via the existing wake-subscriber hook so the caller is alerted without polling.

#### Scenario: Silent failure appears in fleet
- **WHEN** the LLM calls `acp_status({ view: "fleet" })` after a run failed silently
- **THEN** the entry SHALL show `{ state: "failed", error: { reason: "silent-no-output" } }`
- **AND** the entry SHALL NOT be filtered out by default fleet filters

#### Scenario: Silent failure wakes parent session
- **WHEN** a run transitions to `failed` with `reason: "silent-no-output"`
- **THEN** the wake-subscriber SHALL publish a wake event to the parent session within 5 seconds
- **AND** the wake event SHALL include the `runId` and `reason` so the parent can decide whether to retry

### Requirement: Silent failure is retryable via resume

A run that failed with `reason: "silent-no-output"` SHALL be retryable via `acp_status({ action: "resume", id, message })` without requiring a fresh `acp_spawn`. The resume SHALL re-engage the same session or spawn a replacement if the original was disposed.

#### Scenario: Resume a silent-failure run
- **WHEN** the LLM calls `acp_status({ action: "resume", id: "<silentFailedRunId>", message: "Write the tests to test/" })` on a silent-failure run
- **THEN** the system SHALL re-engage (or re-spawn) the session, transition `state` to `"running"`, and reset the silent-detection counters
- **AND** if the resumed run again produces no output, it SHALL fail again with `"silent-no-output"`

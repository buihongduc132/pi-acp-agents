## ADDED Requirements

### Requirement: Heartbeat file written on every fire attempt

scold-reminder SHALL write a heartbeat record to
`~/.pi-scold-reminder/heartbeat.json` on every fire/inject attempt, regardless
of whether an injection was actually delivered. The write SHALL be atomic
(write to `.tmp.<pid>.<ts>` then `rename`) and protected by a file lock
(`heartbeat.json.lock`). The record SHALL include at minimum:
`schemaVersion`, `lastFireAt` (ISO 8601), `lastInjectedAt` (ISO 8601, may equal
`lastFireAt`), `phase`, `intervalMs`, `turnsSinceFire`, `error`, `configVersion`,
`host`, `pid`. `pid` is diagnostic only and SHALL NOT be used as a liveness
source.

This pattern reuses the teams `heartbeat-lease.ts` timestamp-age + atomic-write
approach verbatim (see `pi-plugins/flow/findings/curator-research-teams-staleness.md`).

#### Scenario: Successful fire writes heartbeat
- **WHEN** scold-reminder fires on `message_end` and either injects a reminder or decides not to inject this turn
- **THEN** `~/.pi-scold-reminder/heartbeat.json` is atomically rewritten with `lastFireAt` set to the current time and `phase: "live"`

#### Scenario: Injection delivered records separate timestamp
- **WHEN** scold-reminder fires and actually injects a reminder
- **THEN** `lastInjectedAt` is set to the current time in the heartbeat record

#### Scenario: Atomic write survives concurrent pi sessions
- **WHEN** two pi sessions fire scold-reminder concurrently
- **THEN** both writes complete without corruption (each writes via a unique `.tmp.<pid>.<ts>` then `rename` under `heartbeat.json.lock`); no half-written file is ever readable

### Requirement: Phase enum reflects liveness state

The heartbeat `phase` field SHALL take exactly one of: `live`, `stale`, `dead`,
`error`, `disabled`. The phase transitions SHALL be monotone per failure: a
throwing hook moves to `error`; an aging heartbeat moves through `stale` then
`dead` as thresholds are crossed; a successful fire returns to `live`.

#### Scenario: Hook throws writes error phase
- **WHEN** a scold-reminder hook (session_start, context, message_end, or session_shutdown) throws
- **THEN** the throw is caught, the heartbeat record is written with `phase: "error"` and `error: { message, code, errorAt }` set, and the UI indicator (per the UI-only indicator requirement) flips to error

#### Scenario: Recovered fire returns to live
- **WHEN** a fire succeeds after a prior `phase: "error"`
- **THEN** the new heartbeat record sets `phase: "live"` and clears `error: null`

### Requirement: Staleness classifier runs on turn_end

scold-reminder SHALL, on every `turn_end`, read the heartbeat file and classify
the phase using timestamp age against the configured `intervalMs`:
- age ≤ `intervalMs × 2` → `live`
- age ≤ `intervalMs × 4` → `stale`
- age > `intervalMs × 4` → `dead`

This SHALL reuse the teams `assessWorkerHeartbeatFreshness` timestamp-age math
pattern (not a PID check). The multipliers (2× stale, 4× dead) SHALL be module
constants and documented as tunable.

#### Scenario: Heartbeat within fresh window stays live
- **WHEN** `turn_end` fires and `lastFireAt` age ≤ `intervalMs × 2`
- **THEN** the classifier reports `live`

#### Scenario: Aging heartbeat becomes stale
- **WHEN** `turn_end` fires and `lastFireAt` age is between `intervalMs × 2` and `intervalMs × 4`
- **THEN** the classifier reports `stale`

#### Scenario: Long-dead heartbeat becomes dead
- **WHEN** `turn_end` fires and `lastFireAt` age > `intervalMs × 4`
- **THEN** the classifier reports `dead`

#### Scenario: Missing heartbeat file
- **WHEN** `turn_end` fires and `~/.pi-scold-reminder/heartbeat.json` does not exist or is unparseable
- **THEN** the classifier reports `stale` with reason `missing` or `invalid` (never throws)

### Requirement: UI indicator is UI-ONLY and transitions-only

scold-reminder SHALL surface its phase via `ctx.ui.setStatus` (every
classification that results in a phase transition) and `ctx.ui.notify` (on
transitions into `error` or `dead`). Liveness state SHALL NOT be delivered via
`ctx.sendMessage`, `sendUserMessage`, or any API that injects into the
conversation context. This complies with the AGENTS.md indicator-visibility
rule: liveness is operational, not behavioral, and must not appear in branches
seen by delegated agents (ACP, teams).

#### Scenario: Status updated on phase transition
- **WHEN** the classifier reports a phase different from the previously reported phase
- **THEN** `ctx.ui.setStatus` is called with a human-readable label (e.g. "scold-reminder: stale")

#### Scenario: Notify on error or dead
- **WHEN** the phase transitions into `error` or `dead`
- **THEN** `ctx.ui.notify` is called with a short message; no message is sent to the conversation context

#### Scenario: No status spam on repeated identical phases
- **WHEN** the classifier reports the same phase as the previous turn
- **THEN** no `setStatus` / `notify` call is made

### Requirement: Self-recover warning on session start

On `session_start`, scold-reminder SHALL read the heartbeat file. If
`phase === "error"` OR `lastFireAt` age exceeds the dead threshold (carried over
from a prior session), scold-reminder SHALL call `ctx.ui.notify` prompting the
user to run `/scold-restart`. scold-reminder SHALL NOT auto-restart (user
agency preserved). This check SHALL NOT block session start (fire-and-forget;
on read failure it SHALL silently no-op).

#### Scenario: Stale heartbeat from prior session surfaces warning
- **WHEN** a new pi session starts and the heartbeat file shows `phase: "error"` or a `lastFireAt` older than the dead threshold
- **THEN** `ctx.ui.notify` is called with a message prompting `/scold-restart`

#### Scenario: Fresh heartbeat is silent on start
- **WHEN** a new session starts and the heartbeat is live (recent `lastFireAt`, `phase: "live"`)
- **THEN** no notification is emitted

#### Scenario: Missing heartbeat file is silent on start
- **WHEN** a new session starts and no heartbeat file exists
- **THEN** no notification is emitted and session start is not blocked

### Requirement: Failure mode never blocks

No scold-reminder hook (including the new heartbeat write, classifier, UI
indicator, and session-start warning) SHALL block the main pi workflow or
propagate an exception to the caller. Every hook SHALL catch its own errors,
log them to the UI only, and return a safe default. This complies with the
AGENTS.md exception-safety rule ("Hooks MUST NOT block when exceptions occur.
Catch → log → return safe default.").

#### Scenario: Heartbeat write failure does not break injection
- **WHEN** the heartbeat file write throws (disk full, permission denied)
- **THEN** the error is caught, logged to UI, and the reminder injection proceeds unaffected

#### Scenario: Classifier read failure does not break turn
- **WHEN** reading the heartbeat file throws on `turn_end`
- **THEN** the classifier reports `stale` with reason `invalid`, logs to UI, and the turn completes normally

### Requirement: Heartbeat file location and schema are stable

The heartbeat file path SHALL be `~/.pi-scold-reminder/heartbeat.json`
(hardcoded; parity with the `~/.pi-curator/` layout the curator plugin will
use). The JSON schema SHALL include a `schemaVersion` field (initially `1`) so
future format changes can be detected and migrated.

#### Scenario: First fire creates the file
- **WHEN** scold-reminder fires for the first time on a machine
- **THEN** `~/.pi-scold-reminder/heartbeat.json` is created (parent directory created if missing) with `schemaVersion: 1`

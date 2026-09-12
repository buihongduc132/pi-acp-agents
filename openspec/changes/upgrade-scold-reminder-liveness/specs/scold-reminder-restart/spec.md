## ADDED Requirements

### Requirement: /scold-restart slash command exists and is non-blocking

scold-reminder SHALL register a slash command named `/scold-restart` (with
`/scold-reminder restart` accepted as an alias). Invoking it SHALL re-enable the
extension (if it was disabled), re-read its config (re-embedding the reminder
pool if embedding mode is active), clear any stale/error phase, write a fresh
`lastFireAt = now` to the heartbeat file, and return immediately. The command
SHALL NOT block the main pi workflow, spawn a long-running task, or require a
full pi restart.

#### Scenario: Restart from stale state
- **WHEN** the user runs `/scold-restart` while the heartbeat shows `phase: "stale"` or `phase: "dead"`
- **THEN** scold-reminder re-reads config, writes `phase: "live"` and `lastFireAt = now` to the heartbeat file, and confirms via `ctx.ui.notify` that it is live

#### Scenario: Restart from error state
- **WHEN** the user runs `/scold-restart` while the heartbeat shows `phase: "error"`
- **THEN** scold-reminder clears the `error` field, re-reads config, and writes `phase: "live"`

#### Scenario: Restart returns immediately
- **WHEN** the user runs `/scold-restart`
- **THEN** the command returns control to the user without waiting for the next fire or any long-running operation; any config re-embedding runs in the background or is lazy

### Requirement: /scold-restart is idempotent

Running `/scold-restart` multiple times in succession SHALL produce the same
result as running it once (no duplicated state, no error from re-running on an
already-live extension). It SHALL be safe to invoke at any phase, including
`live`.

#### Scenario: Restart when already live
- **WHEN** the user runs `/scold-restart` while `phase: "live"`
- **THEN** scold-reminder re-reads config (no-op if unchanged), refreshes `lastFireAt`, and reports it is live; no error is raised

#### Scenario: Restart twice in a row
- **WHEN** the user runs `/scold-restart` twice in quick succession
- **THEN** both invocations complete without error and the heartbeat ends in `phase: "live"`

### Requirement: /scold-restart surfaces config errors instead of faking success

If re-reading the config fails (parse error, schema violation, missing file),
`/scold-restart` SHALL NOT pretend success. It SHALL write `phase: "error"`
with `error: { message, code, errorAt }` to the heartbeat file and report the
failure via `ctx.ui.notify`. This prevents a restart from hiding a persistent
config bug (per the verifier M16 anti-gold-plating lesson and the user's "must
be able to self recover" demand — recovery that lies is not recovery).

#### Scenario: Restart with broken config surfaces error
- **WHEN** the user runs `/scold-restart` and the config file is unparseable
- **THEN** the heartbeat is written with `phase: "error"` and a descriptive `error.message`, and `ctx.ui.notify` reports the config error rather than claiming success

#### Scenario: Restart with missing config uses defaults or errors per config policy
- **WHEN** the user runs `/scold-restart` and no config file exists
- **THEN** scold-reminder applies its documented default-config policy (either built-in defaults or explicit error, as defined by the existing scold-reminder config loader) and reports the outcome truthfully

### Requirement: /scold-restart does not persist into conversation context

The slash command's response SHALL be UI-only (`ctx.ui.notify` /
`ctx.ui.setStatus`). It SHALL NOT inject a system or user message into the
conversation context, consistent with the AGENTS.md indicator-visibility rule.
This keeps liveness/recovery operational state out of branches seen by
delegated agents (ACP, teams).

#### Scenario: Restart response is UI-only
- **WHEN** the user runs `/scold-restart`
- **THEN** the confirmation appears via `ctx.ui.notify`; no message is added to the conversation branch that delegated agents would see

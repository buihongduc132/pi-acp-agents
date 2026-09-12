## ADDED Requirements

### Requirement: Curator runtime extension is loadable via `-e` only

The `pi-curator-runtime` extension SHALL be loadable as the sole runtime extension of a curator child process via `pi --no-extensions -e <pi-curator-runtime-path> -e <pi-intercom-path> ...`. The runtime extension SHALL NOT depend on `settings.json` being present (it is spawned with `--no-extensions`). The runtime extension SHALL be the ONLY mechanism by which a curator refreshes its heartbeat, transitions phases, and marks completion.

#### Scenario: Runtime loads without settings.json
- **WHEN** a curator is spawned with `--no-extensions -e <runtime> -e <intercom>`
- **THEN** the curator runtime extension SHALL initialize successfully without reading any `settings.json`

#### Scenario: Runtime is the heartbeat owner
- **WHEN** the curator is running
- **THEN** the runtime extension SHALL own the heartbeat refresh loop and phase transitions — no other extension shall write to the curator's `pids/` file

---

### Requirement: Heartbeat refresh loop

The curator runtime SHALL start a `setInterval` heartbeat loop at first init that writes `{heartbeatAt: <now-ISO>, phase: <current>, pid: process.pid}` to its `pids/<mainSessionId>/<curator>.json` file every `heartbeat.intervalSec` seconds (default 5). The loop SHALL use atomic writes (`.tmp.<pid>.<ts>` + rename) and `withLock` around every read-modify-write. If a heartbeat write fails, the loop SHALL swallow the error (matching the teams `publishHeartbeat` swallowing pattern) and retry on the next tick — a single failed heartbeat write MUST NOT crash the curator.

#### Scenario: Heartbeat writes every interval
- **WHEN** the curator runtime is running with `heartbeat.intervalSec: 5`
- **THEN** the `pids/` file's `heartbeatAt` field SHALL be updated to a fresh ISO timestamp every 5 seconds

#### Scenario: Heartbeat write failure does not crash curator
- **WHEN** a single heartbeat write fails (e.g. disk error)
- **THEN** the curator SHALL log/swallow the error and continue running; the next tick SHALL retry the write

#### Scenario: Concurrent heartbeat writes are serialized
- **WHEN** two heartbeat ticks race (because the previous tick was slow)
- **THEN** the runtime SHALL guard with an in-flight flag (`heartbeatInFlight`) and skip the overlapping tick rather than corrupt the file

---

### Requirement: Phase transitions

The curator runtime SHALL transition its `phase` through the following ordered states: `spawned` (written by main BEFORE spawn returns) → `scanning` (curator's first heartbeat, beginning review) → `signaling` (curator invokes `signal_main`) → `done` (curator finished; LAST act before exit). The runtime SHALL write each transition atomically. The `phase: "done"` write SHALL happen inside `process.on('beforeExit')` so it lands even on uncaught throws (the throw still propagates, but the phase marker lands first).

#### Scenario: First heartbeat sets scanning
- **WHEN** the curator runtime starts its first heartbeat tick
- **THEN** the runtime SHALL set `phase` to `"scanning"`

#### Scenario: Curator sets signaling when invoking signal_main
- **WHEN** the curator invokes the `signal_main` tool
- **THEN** the runtime SHALL set `phase` to `"signaling"` before or during the tool invocation

#### Scenario: Curator sets done before exit (clean path)
- **WHEN** the curator finishes its task and exits cleanly
- **THEN** the runtime SHALL set `phase` to `"done"` via `process.on('beforeExit')` as the final act

#### Scenario: Curator sets done before exit (throw path)
- **WHEN** the curator throws an uncaught error
- **THEN** the `process.on('beforeExit')` handler SHALL still fire and set `phase` to `"done"` BEFORE the process exits with the error

#### Scenario: Hard crash leaves last phase (slot freed via heartbeat)
- **WHEN** the curator is SIGKILLed (hard crash, no `beforeExit`)
- **THEN** the `phase` SHALL remain at its last value (e.g. `"scanning"`), and the main-side staleness detector SHALL reclassify the slot as FREE via the dead-heartbeat path within `heartbeat.deadSec` (default 120s)

---

### Requirement: Graceful degradation when signal_main is absent

The curator runtime SHALL detect at startup whether the `signal_main` tool is available (registered by `add-curator-signal`). If `signal_main` is absent, the curator SHALL: (1) log the absence via stderr (visible in `~/.pi-curator/logs/`), (2) proceed with its analysis read-only, (3) set `phase: "done"` and exit normally. The runtime SHALL NOT crash or hold its slot when `signal_main` is missing.

#### Scenario: Curator runs without signal_main
- **WHEN** the curator runtime starts and `signal_main` is not a registered tool
- **THEN** the curator SHALL log to stderr, run its analysis, set `phase: "done"`, and exit cleanly

#### Scenario: Curator does not block slot when signal_main is absent
- **WHEN** the curator finishes analysis without `signal_main` and exits
- **THEN** the main-side hook SHALL treat the slot as FREE on the next gate-eligible turn (because `phase: "done"`)

---

### Requirement: Curator-side beforeExit handler is non-throwing

The `process.on('beforeExit')` handler that writes `phase: "done"` SHALL itself be wrapped in a try/catch and SHALL NOT throw. If the atomic write fails (e.g. disk error), the handler SHALL swallow the error and exit — the main-side staleness detector will reclassify the slot as FREE via the dead-heartbeat path within `heartbeat.deadSec`.

#### Scenario: beforeExit write failure does not re-throw
- **WHEN** the `beforeExit` handler's atomic write to `pids/` fails
- **THEN** the handler SHALL swallow the error, exit normally, and the main-side staleness detector SHALL free the slot via the dead-heartbeat path

---

### Requirement: Curator runtime does not load main-side pi-curator extension

The curator runtime SHALL be invoked with `--no-extensions -e <runtime> -e <intercom>`. Because of `--no-extensions`, the curator MUST NOT inherit the main-side `pi-curator` extension from `settings.json`. This prevents recursion (the curator's own `turn_end` would otherwise spawn sub-curators). The runtime extension SHALL verify at init that it is NOT running alongside the main-side `pi-curator` extension and SHALL log a warning if it detects otherwise (defensive check; should never trigger in normal operation).

#### Scenario: Curator does not spawn sub-curators
- **WHEN** the curator reaches its own `turn_end`
- **THEN** the curator MUST NOT spawn any sub-curators — no main-side `pi-curator` extension is loaded

#### Scenario: Defensive check warns on misconfiguration
- **WHEN** the curator runtime detects the main-side `pi-curator` extension is loaded alongside it (misconfiguration)
- **THEN** the runtime SHALL log a warning via stderr and continue (it cannot spawn sub-curators itself, but the warning surfaces the misconfiguration for debugging)

## ADDED Requirements

### Requirement: Spawn gate — per-persona cadence control

The system SHALL NOT spawn a curator for a persona unless the per-persona spawn gate is satisfied. The gate SHALL evaluate two independent triggers (either suffices): `turn >= everyTurns` since last spawn OR `minutes >= everyMins` since last spawn. The gate state SHALL be persisted at `~/.pi-curator/spawn-log/<mainSessionId>/<curator>.json` containing `{lastSpawnAt, lastSpawnTurn}` and MUST survive the janitor sweep (the janitor does NOT GC `spawn-log/` — only the 24h artifact GC does). On successful spawn, the gate state file SHALL be atomically updated with the new timestamp and turn.

#### Scenario: Gate blocks spawn when neither trigger is met
- **WHEN** the persona config sets `spawn.everyTurns: 10` and `spawn.everyMins: 5`, and the last spawn was 3 turns ago and 2 minutes ago
- **THEN** the hook SHALL skip spawning that persona and leave `spawn-log/` unchanged

#### Scenario: Gate allows spawn when turn threshold reached
- **WHEN** the persona config sets `spawn.everyTurns: 10`, and the last spawn was 10 or more turns ago
- **THEN** the hook SHALL proceed to spawn a new curator for that persona and atomically update `spawn-log/<mainSessionId>/<curator>.json` with `lastSpawnAt` and `lastSpawnTurn`

#### Scenario: Gate allows spawn when minute threshold reached
- **WHEN** the persona config sets `spawn.everyMins: 5`, and the last spawn was 5 or more minutes ago (regardless of turn count)
- **THEN** the hook SHALL proceed to spawn a new curator for that persona

#### Scenario: Gate state survives janitor sweep
- **WHEN** the PM2 janitor has run its 5-minute tick after a spawn
- **THEN** the `spawn-log/` file MUST still exist and contain the correct `lastSpawnAt` and `lastSpawnTurn` — the gate MUST NOT re-trigger on the next turn

#### Scenario: Missing spawn-log means gate passes
- **WHEN** no `spawn-log/<mainSessionId>/<curator>.json` exists
- **THEN** the gate SHALL treat the persona as "never spawned" and allow spawn

---

### Requirement: Non-bias context filter

The system SHALL filter the main session JSONL into a trimmed fork-input file before each spawn. The filter MUST: (a) operate on the active branch only (ignore off-branch entries), (b) drop `thinking` blocks from assistant messages, (c) PRESERVE `compaction` entries (they carry pre-compaction requirements), (d) preserve `message`, `custom_message`, and `branch_summary` entries, (e) discard non-context entry types (`session_info`, `model_change`, `thinking_level_change`, `label`).

#### Scenario: Thinking blocks are stripped
- **WHEN** the main session JSONL contains an assistant message with `thinking` blocks
- **THEN** the filtered output MUST contain the same assistant message with all `thinking` blocks removed, and the rest of the message content preserved

#### Scenario: Compaction entries are preserved
- **WHEN** the main session JSONL contains a `compaction` entry (with `summary` and `firstKeptEntryId`)
- **THEN** the filtered output MUST include the `compaction` entry intact — it MUST NOT be dropped

#### Scenario: Only active branch is included
- **WHEN** the main session JSONL has off-branch entries from abandoned conversation branches
- **THEN** the filtered output MUST NOT include any off-branch entries

#### Scenario: Non-context entry types are discarded
- **WHEN** the main session JSONL contains `session_info`, `model_change`, `thinking_level_change`, or `label` entries
- **THEN** the filtered output MUST NOT include any of these entry types

---

### Requirement: Trim budget — 60% recent target, 90% ceiling

The filter SHALL trim from the top (drop oldest turns first) using the following algorithm: (1) compute `effectiveBudget = floor(curatorModel.contextWindow * 0.9) - reserveForOutput` (reserveForOutput default 8192 tokens), (2) walk turns newest-first accumulating `estimateTokens()` (chars/4 heuristic matching pi's own accounting), (3) prepend each turn to `kept` until adding the next would exceed `effectiveBudget`, (4) if `kept.length / turns.length < 0.6` and there is headroom under `effectiveBudget`, continue walking older turns until 60% reached or budget exhausted, (5) never cut a tool result away from its tool call (turns are atomic units), (6) if a single turn exceeds `effectiveBudget`, trim within that turn by dropping intermediate tool results oldest-first until it fits, while keeping the user message and final assistant text.

#### Scenario: Trim respects 90% ceiling
- **WHEN** the curator model contextWindow is 100,000 tokens and reserveForOutput is 8192
- **THEN** the effectiveBudget SHALL be 81,808 tokens and the filtered output MUST NOT exceed this estimated token count

#### Scenario: 60% target honored when budget allows
- **WHEN** the total turns fit within effectiveBudget
- **THEN** the filtered output SHALL include all turns (100% > 60% target)

#### Scenario: Single oversized turn is trimmed within
- **WHEN** the newest turn alone exceeds effectiveBudget
- **THEN** the filter SHALL trim within that turn by dropping intermediate tool results oldest-first until the turn fits, preserving the user message and final assistant text

#### Scenario: Tool call/result never split
- **WHEN** a turn contains a tool call followed by its tool result
- **THEN** the filter MUST NOT drop the tool result while keeping the tool call, or vice versa

---

### Requirement: Child spawn primitive — anti-recursion

The spawn command SHALL be: `pi --no-extensions -e <pi-curator-runtime-path> -e <pi-intercom-path> --fork <filtered.jsonl> --append-system-prompt <goalFile> --name "curator:<alias>" --model <model> -p "<taskPrompt>"`. The child process SHALL be spawned via `child_process.spawn({detached: false})` so the child dies with the main process. The `--no-extensions` flag MUST be present to prevent the forked curator from inheriting the main's `settings.json` and loading the main-side `pi-curator` extension (which would trigger recursion). The two `-e` flags re-add ONLY the curator runtime and intercom extensions. Stdio SHALL be configured as: `stdin` = ignore, `stdout` = `/dev/null`, `stderr` = append to `~/.pi-curator/logs/<mainSessionId>/<curator>-<ts>.stderr`.

#### Scenario: Spawn command prevents recursion
- **WHEN** the main session has `pi-curator` in its `settings.json` extensions
- **THEN** the spawned curator command MUST include `--no-extensions` so the child does NOT load `pi-curator` from settings.json

#### Scenario: Child dies with main process
- **WHEN** the main pi process exits (SIGTERM, SIGINT, or normal exit)
- **THEN** the curator child process MUST also terminate (because it was spawned with `detached: false`)

#### Scenario: Spawn is fire-and-forget
- **WHEN** the `turn_end` hook triggers a spawn
- **THEN** the hook SHALL NOT await the child's completion; the hook SHALL return immediately after `child_process.spawn` returns

#### Scenario: Spawn errors are non-blocking
- **WHEN** `child_process.spawn` throws (e.g. `pi` binary not found)
- **THEN** the hook SHALL catch the error, log it UI-only via `ctx.ui.setStatus`, and return a safe default — the main turn MUST NOT be blocked or crashed

---

### Requirement: PID + heartbeat registration

The system SHALL write a PID registration file at `~/.pi-curator/pids/<mainSessionId>/<curator>.json` BEFORE invoking `child_process.spawn`. The file SHALL contain `{pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt, phase, goalFile}`. The curator runtime SHALL refresh `heartbeatAt` every `heartbeat.intervalSec` seconds (default 5) and update `phase` as it progresses through its task. All file writes SHALL use atomic write (`.tmp.<pid>.<ts>` + rename) and `withLock` around every read-modify-write.

#### Scenario: PID file written before spawn
- **WHEN** the hook decides to spawn a curator
- **THEN** the `pids/<mainSessionId>/<curator>.json` file SHALL be written with `phase: "spawned"` BEFORE `child_process.spawn` is called

#### Scenario: Curator refreshes heartbeat
- **WHEN** the curator runtime is running
- **THEN** it SHALL update `heartbeatAt` to current timestamp every `heartbeat.intervalSec` (default 5) seconds via atomic write

#### Scenario: Curator updates phase during work
- **WHEN** the curator transitions from scanning to signaling
- **THEN** the curator runtime SHALL atomically update the `phase` field in its `pids/` file to `"signaling"`

---

### Requirement: Staleness detection — UI-only

The main-side hook SHALL assess curator staleness on every `turn_end` using the heartbeat-lease math reused from `pi-agent-teams`: live if `heartbeatAt` age ≤ `heartbeat.staleSec` (default 30s), stale if 30–120s, dead if > `heartbeat.deadSec` (default 120s) OR `isPidAlive(pid)` returns false. Staleness status SHALL be surfaced exclusively via `ctx.ui.setStatus` (UI-only) and MUST NOT be injected into conversation context (ACP/teams delegated branches MUST NOT see it).

#### Scenario: Fresh heartbeat reports alive
- **WHEN** the curator's `heartbeatAt` was refreshed 10 seconds ago
- **THEN** `ctx.ui.setStatus` SHALL report the curator as `live`

#### Scenario: Stale heartbeat reports warning
- **WHEN** the curator's `heartbeatAt` was refreshed 60 seconds ago
- **THEN** `ctx.ui.setStatus` SHALL report the curator as `stale`

#### Scenario: Dead heartbeat reports dead
- **WHEN** the curator's `heartbeatAt` was refreshed 180 seconds ago
- **THEN** `ctx.ui.setStatus` SHALL report the curator as `dead`

#### Scenario: Dead PID reports dead regardless of heartbeat
- **WHEN** `process.kill(pid, 0)` throws ESRCH (process gone)
- **THEN** the staleness detection SHALL report `dead` even if `heartbeatAt` age is within stale range

#### Scenario: Staleness is never in conversation context
- **WHEN** staleness is assessed
- **THEN** the status output SHALL appear only via `ctx.ui.setStatus` and MUST NOT be injected as a `custom_message` or any form that enters the LLM context

---

### Requirement: Phase-aware exclusivity

The system SHALL enforce one curator per `(mainSession, persona)` pair. The spawn hook SHALL skip spawning ONLY if the existing `pids/<mainSessionId>/<curator>.json` has `phase` ∈ `{spawned, scanning, signaling, running}`. If `phase` is `"done"` OR the curator is classified as `dead` (per staleness detection), the slot SHALL be FREE and spawn SHALL proceed. This ensures a completed or crashed curator does not block re-spawning.

#### Scenario: Active curator blocks re-spawn
- **WHEN** a `pids/` file exists for the persona with `phase: "scanning"` and heartbeat is fresh
- **THEN** the hook SHALL skip spawning for that persona

#### Scenario: Completed curator frees the slot
- **WHEN** a `pids/` file exists for the persona with `phase: "done"`
- **THEN** the hook SHALL treat the slot as FREE and proceed to spawn a new curator

#### Scenario: Dead curator frees the slot
- **WHEN** a `pids/` file exists for the persona but `heartbeatAt` age exceeds `deadSec` or `isPidAlive(pid)` returns false
- **THEN** the hook SHALL treat the slot as FREE and proceed to spawn a new curator

#### Scenario: Missing pids file allows spawn
- **WHEN** no `pids/<mainSessionId>/<curator>.json` exists
- **THEN** the hook SHALL treat the slot as FREE and proceed to spawn

---

### Requirement: PM2 janitor — GC only, never spawns

The system SHALL run a stateless PM2 process under namespace `pi-curator:<project>` (where `<project>` = `basename(git rev-parse --show-toplevel)`, or `basename(cwd)` fallback). The janitor SHALL tick every 5 minutes and: (1) SIGTERM any curator whose `heartbeatAt` age exceeds `deadSec` or whose PID is dead, (2) archive dead curator `pids/` entries to `~/.pi-curator/archive/<timestamp>/`, (3) GC fork artifacts (trimmed JSONL files and log files) older than 24 hours. The janitor SHALL NOT spawn curators — spawning is the main session's responsibility.

#### Scenario: Janitor SIGTERMs dead curators
- **WHEN** the janitor tick finds a curator with `heartbeatAt` age > `deadSec` (default 120s)
- **THEN** the janitor SHALL send SIGTERM to the curator PID and archive its `pids/` entry

#### Scenario: Janitor GCs old artifacts
- **WHEN** the janitor tick finds a trimmed JSONL or stderr log file older than 24 hours
- **THEN** the janitor SHALL delete the file

#### Scenario: Janitor never spawns curators
- **WHEN** the janitor detects a dead curator slot
- **THEN** the janitor SHALL archive the dead entry and MUST NOT spawn a replacement — re-spawn is the main-side hook's responsibility

#### Scenario: Janitor namespace is project-scoped
- **WHEN** the main session is in a git repo at `/home/user/projects/myapp`
- **THEN** the janitor PM2 process name SHALL be `pi-curator:myapp` (basename of git toplevel)

#### Scenario: Non-git fallback for project name
- **WHEN** the main session is NOT in a git repo and cwd is `/home/user/work`
- **THEN** the janitor PM2 process name SHALL be `pi-curator:work` (basename of cwd)

---

### Requirement: Slash commands — list, status, kill

The system SHALL register three slash commands: `/curator list` (enumerate all curator `pids/` entries across all main sessions), `/curator status [<alias>]` (detailed staleness + phase for one or all curators), `/curator kill <alias>` (SIGTERM a specific curator, set its phase to `exiting`). The system SHALL NOT register `/curator restart` — restart is achieved by `kill` followed by the next gate-eligible turn re-spawning naturally.

#### Scenario: /curator list shows all curators
- **WHEN** the user invokes `/curator list`
- **THEN** the system SHALL enumerate all `pids/` entries across all `mainSessionId` directories and display each curator's alias, phase, and heartbeat age

#### Scenario: /curator status shows detail for one curator
- **WHEN** the user invokes `/curator status guardian`
- **THEN** the system SHALL display the full `pids/` file contents for the `guardian` curator including staleness classification

#### Scenario: /curator kill sends SIGTERM
- **WHEN** the user invokes `/curator kill guardian`
- **THEN** the system SHALL send SIGTERM to the guardian's PID and atomically update its `phase` to `"exiting"`

#### Scenario: /curator restart is not available
- **WHEN** the user attempts `/curator restart`
- **THEN** the system SHALL report the command is not available and suggest `/curator kill` followed by waiting for the next gate-eligible turn

---

### Requirement: Non-blocking + exception-safe hook

The `turn_end` hook SHALL wrap all curator work in a try/catch. On any exception, the hook SHALL log the error UI-only via `ctx.ui.setStatus` and return a safe default. The hook MUST NOT block the main turn — filtering and spawn must complete synchronously (JSONL read + in-memory trim + `child_process.spawn`) and yield without awaiting the child.

#### Scenario: Filter error does not block main
- **WHEN** the JSONL filter encounters a malformed line
- **THEN** the hook SHALL skip the malformed line (or the entire filter) and return a safe default without blocking or crashing the main turn

#### Scenario: Spawn error does not crash main
- **WHEN** `child_process.spawn` throws
- **THEN** the hook SHALL catch the error, update `ctx.ui.setStatus` with the error, and return safely

---

### Requirement: Default task prompt template

The system SHALL generate a default task prompt for each curator spawn that includes: (1) identification as a sidecar of the main session (name + id), (2) pointer to the goalFile as its instructions, (3) scope statement (main-only), (4) reference to the `signal_main` tool for communicating findings (delivered by `add-curator-signal`), (5) instruction not to modify files unless the persona explicitly allows it, (6) instruction to exit when done. The template SHALL be a prose prompt (NOT code) per locked decision "intercom will be in prose prompt."

#### Scenario: Default task prompt references goalFile
- **WHEN** the system generates a task prompt for a curator with alias `guardian`
- **THEN** the prompt SHALL include the path to the curator's goalFile and instruct the curator to follow it

#### Scenario: Default task prompt references signal_main
- **WHEN** the system generates a task prompt
- **THEN** the prompt SHALL mention `signal_main` as the tool for communicating findings to the main session

#### Scenario: Curator degrades gracefully when signal_main is absent
- **WHEN** the curator runtime starts and the `signal_main` tool is not available (because `add-curator-signal` has not landed)
- **THEN** the curator SHALL log its inability to signal, complete its analysis, set `phase: done`, and exit without crashing

## ADDED Requirements

### Requirement: Persona-layered config with deep-merge

The system SHALL read curator persona configuration from two locations and deep-merge them: global `~/.pi-curator/curators.json` and project `.pi-curator/curators.json` (project overrides global). The merged config SHALL be keyed by persona alias (a friendly, non-jargon name). Deep-merge means project-level keys override global-level keys at any depth; arrays are REPLACED (not concatenated).

#### Scenario: Project overrides global
- **WHEN** `~/.pi-curator/curators.json` sets `guardian.spawn.everyTurns: 10` and `.pi-curator/curators.json` sets `guardian.spawn.everyTurns: 5`
- **THEN** the merged config SHALL use `everyTurns: 5` for the `guardian` persona

#### Scenario: Global fills gaps not set in project
- **WHEN** global sets `guardian.heartbeat.intervalSec: 5` and project sets only `guardian.spawn.everyTurns: 3`
- **THEN** the merged config SHALL have both `heartbeat.intervalSec: 5` (from global) and `spawn.everyTurns: 3` (from project)

#### Scenario: Missing config means no curators
- **WHEN** neither `~/.pi-curator/curators.json` nor `.pi-curator/curators.json` exists
- **THEN** the system SHALL treat the persona list as empty and the spawn hook SHALL be a no-op

---

### Requirement: Persona schema

Each persona in the merged config SHALL support the following fields with documented defaults: `enabled` (default `true`), `alias` (required, friendly non-jargon name), `goalFile` (required, absolute or project-relative path), `taskPrompt` (optional, overrides the default task prompt template), `model` (optional, defaults to main's model), `scope` (default `"main-only"`), `spawn.everyTurns` (optional), `spawn.everyMins` (optional), `includeThinking` (default `false`), `contextBudget` (optional, overrides the model's context window for trim), `excludeTools` OR `tools` (mutually exclusive — both set is a config error), `appendDisplay` (default `false`), `heartbeat.intervalSec` (default `5`), `heartbeat.staleSec` (default `30`), `heartbeat.deadSec` (default `120`).

#### Scenario: Alias is required
- **WHEN** a persona entry has no `alias` field
- **THEN** the system SHALL reject the config with an error indicating the persona is missing its alias

#### Scenario: excludeTools and tools are mutually exclusive
- **WHEN** a persona sets BOTH `excludeTools` and `tools`
- **THEN** the system SHALL reject the config with an error indicating the two fields are mutually exclusive

#### Scenario: Tool trim defaults to none
- **WHEN** a persona config sets NEITHER `excludeTools` NOR `tools`
- **THEN** the spawn command SHALL omit both `--exclude-tools` and `--tools` flags entirely (the curator inherits all default tools)

#### Scenario: Disabled persona is skipped
- **WHEN** a persona has `enabled: false`
- **THEN** the spawn hook SHALL skip that persona even if its gate would otherwise pass

---

### Requirement: Default task prompt template generation

The system SHALL generate a default task prompt when a persona does NOT specify `taskPrompt`. The generated prompt SHALL include: (1) identification as a sidecar of the main session by name and id, (2) the goalFile path as the curator's instructions, (3) a scope statement set to `"main-only"` by default, (4) reference to `signal_main` as the tool for communicating findings (delivered by `add-curator-signal`), (5) instruction not to modify files unless the persona explicitly allows it (i.e. unless `tools`/`excludeTools` opt into mutating tools), (6) instruction to exit when done.

#### Scenario: Default prompt is prose not code
- **WHEN** the system generates a task prompt
- **THEN** the prompt SHALL be a prose text (per locked decision "intercom will be in prose prompt") and MUST NOT be implemented as a custom tool

#### Scenario: Custom taskPrompt overrides default
- **WHEN** a persona sets `taskPrompt: "Review for security issues and report findings"`
- **THEN** the system SHALL use that literal prompt instead of the default template

---

### Requirement: Tool trim is opt-in only

The system SHALL NOT add `--exclude-tools` or `--tools` to the spawn command UNLESS the persona config explicitly sets one of them. This matches the locked user decision "tool trim default: NOTHING (omit flag if config doesn't set)".

#### Scenario: No tool trim by default
- **WHEN** a persona config sets neither `excludeTools` nor `tools`
- **THEN** the spawn command SHALL NOT contain `--exclude-tools` or `--tools` and the curator SHALL inherit all default tools

#### Scenario: excludeTools adds flag
- **WHEN** a persona config sets `excludeTools: ["bash", "edit", "write"]`
- **THEN** the spawn command SHALL include `--exclude-tools bash,edit,write`

#### Scenario: tools allowlist adds flag
- **WHEN** a persona config sets `tools: ["read", "ls", "grep"]`
- **THEN** the spawn command SHALL include `--tools read,ls,grep`

---

### Requirement: Config errors are non-fatal and surfaced UI-only

When the merged config is malformed (missing required fields, mutually-exclusive violations, invalid types), the system SHALL log the error UI-only via `ctx.ui.setStatus` and skip the offending persona. The system SHALL NOT crash the main session or block the turn.

#### Scenario: Malformed persona is skipped
- **WHEN** the merged config has a persona missing `alias` and another persona that is valid
- **THEN** the system SHALL log the error for the malformed persona, skip it, and still spawn curators for the valid persona

#### Scenario: Config error surfaces UI-only
- **WHEN** any config validation error occurs
- **THEN** the error SHALL appear only via `ctx.ui.setStatus` and MUST NOT be injected into conversation context

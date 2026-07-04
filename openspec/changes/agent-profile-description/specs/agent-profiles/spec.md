## ADDED Requirements

### Requirement: Agent profile description field

Each entry in `agent_servers` SHALL accept an optional `description: string`
field that provides a human-readable summary of what the profile does and when
to use it. The field MUST be optional; its absence MUST NOT prevent config
load or agent spawn. The field MUST NOT be interpreted as code or executed.

#### Scenario: Config with description loads
- **WHEN** `~/.pi/acp-agents/config.json` contains an `agent_servers` entry
  with a `description` field set to a non-empty string
- **THEN** `loadConfig()` returns successfully and the entry's `description`
  is present on the resolved `AcpAgentConfig`

#### Scenario: Config without description still loads
- **WHEN** an `agent_servers` entry omits `description`
- **THEN** `loadConfig()` returns successfully with `description` unset
  (undefined) and the agent remains spawnable

#### Scenario: Non-string description is rejected
- **WHEN** an `agent_servers` entry sets `description` to a non-string value
  (number, object, array)
- **THEN** `validateConfig()` throws an error naming the offending agent and
  stating `description` must be a string

### Requirement: Server-vs-profile conceptual model documented

The `agent_servers` map SHALL be documented as a map of **agent profiles**,
where each profile is a named persona (system prompt + narrower goal +
optional default model/mode + optional description) that references a
**server** (the transport: `command` + `args` + `env` + `cwd`). Multiple
profiles MAY reference the same server. This distinction SHALL be expressed
in code comments on `AcpAgentConfig` and in the project's AGENTS-level docs.

#### Scenario: One server backs multiple profiles
- **WHEN** two `agent_servers` entries (e.g. `verifier`, `red`) both specify
  `command: "pi-acp"` but differ in `systemPrompt`
- **THEN** both profiles are independently spawnable, each receives its own
  resolved persona at spawn time, and the underlying server binary is shared

#### Scenario: Profile with no persona
- **WHEN** an `agent_servers` entry omits `systemPrompt`
- **THEN** the profile spawns with no injected persona (existing behavior,
  unchanged) and `description` (if present) is still surfaced in listings

### Requirement: Agent listing surfaces description

Every surface that lists configured agent profiles SHALL surface the profile's `description`. This requirement applies to the `/acp agents` command, `acp_status`, `acp_runtime_info`, `acp_doctor`, and the agent-config TUI.

Any surface that lists configured agent profiles (`/acp agents` command,
`acp_status`, `acp_runtime_info`, `acp_doctor`, agent-config TUI) SHALL
include the profile's `description` alongside its name and server command.
When `description` is absent, the surface SHALL display a placeholder
(e.g. `(no description)`) rather than crashing or omitting the row.

#### Scenario: /acp agents shows descriptions
- **WHEN** operator runs `/acp agents` with at least one profile having a
  `description` and at least one without
- **THEN** output shows one row per profile with name, server command, and
  description (or `(no description)` placeholder for the missing one)

#### Scenario: acp_status payload carries description
- **WHEN** `acp_status` is invoked
- **THEN** each agent entry in the result includes a `description` key
  (string when set, undefined/empty when not)

### Requirement: Agent-config TUI edits description

The agent-config TUI editor SHALL expose the `description` field as an
editable text input. Saving an edited description SHALL persist it to
`~/.pi/acp-agents/config.json`. Clearing the field SHALL remove the key
(not write `null`).

#### Scenario: Edit description and save
- **WHEN** operator opens a profile in the agent-config TUI, types a new
  description, and saves
- **THEN** the config file on disk contains the new `description` string for
  that profile, and a subsequent `loadConfig()` returns it

#### Scenario: Clear description and save
- **WHEN** operator clears the description input and saves
- **THEN** the `description` key is absent from that profile's entry in the
  saved config file (not `null`, not empty string)

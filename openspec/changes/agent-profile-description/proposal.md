## Why

Operators spawn agents by alias name (e.g. `acp_delegate { agent: "red" }`) with no
way to discover what each alias does, when to use it, or how it differs from the
underlying server. Today the only signal is the agent key string — there is no
human-readable description, no "when to launch this" guidance, and the
`agent_servers` map conflates two distinct concepts (transport/binary vs.
persona/profile). This makes multi-alias setups (verifier, coder, RED, browser-tester,
general) opaque: a user must read each `systemPrompt` file to tell them apart, and
tooling cannot surface a chooser.

## What Changes

- **Add `description?: string` field** to `AcpAgentConfig` (config schema +
  types package). Free-form, ≤1-2 lines, shown in `/acp status`, TUI chooser,
  and any agent-listing surface.
- **Document the server-vs-profile distinction** in config types and AGENTS-level
  docs: `agent_servers.<key>` is an **agent profile** (named persona + prompt +
  narrower goal + optional default model/mode) that *references* a server
  (command + args + env + cwd = the transport/binary). One server can back many
  profiles (e.g. `pi-acp` backs `pi`, `verifier`, `red`, `general`).
- **Surface descriptions in listing surfaces:**
  - `acp_status` / `acp_runtime_info` include `description` per agent.
  - `agents-command.ts` (`/acp agents`) prints name + description + server.
  - `agent-config-tui.ts` editor exposes a description field.
- **Backfill descriptions** for the 7 known aliases (`claude`, `pi`,
  `verifier`, `coder`, `browser-tester`, `red`, `general`) in the canonical
  config example + this repo's AGENTS docs.
- **Validate** description is a string when present (no length cap enforced in
  code — guidance only; tools may truncate for display).

Non-goals (explicitly out of scope):
- No new "profile" top-level key — profiles continue to live under
  `agent_servers`. The distinction is conceptual + documented, not a schema split.
- No breaking change to existing config files (field is optional).
- No auto-generation of descriptions from `systemPrompt` content.

## Capabilities

### New Capabilities
- `agent-profiles`: Describes agent entries in `agent_servers` as named profiles
  (persona + prompt + goal + description) backed by a server (transport). Covers
  the `description` field, the server-vs-profile conceptual model, and how
  listing surfaces expose descriptions for discovery.

### Modified Capabilities
<!-- None — no existing spec-level behavior changes. agent_servers config schema
     is currently undocumented at the spec layer (no prior capability), so this
     is purely additive. -->

## Impact

- **Code:**
  - `src/config/types.ts` — add `description?: string` to `AcpAgentConfig`.
  - `packages/pi-acp-types/src/index.ts` — mirror the field (parity with
    `systemPrompt` precedent from PR #17).
  - `src/settings/agents-command.ts` — include description in `/acp agents` output.
  - `src/settings/agent-config-tui.ts` — description input field in the editor.
  - `index.ts` — `acp_status` / `showAcpDoctor` / `showAcpConfig` payloads carry
    description; no behavior change.
- **Config:** `~/.pi/acp-agents/config.json` gains optional `description` per
  entry. Existing configs unchanged (field optional).
- **Docs:** AGENTS.md + `flow/` reference updated to articulate the
  server-vs-profile model; canonical example config gains descriptions.
- **Tests:** new unit tests for description field (load, validate, display,
  TUI editor round-trip). Existing config tests must still pass (additive field).
- **Dependencies:** none new.

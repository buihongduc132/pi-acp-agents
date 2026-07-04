## Context

`pi-acp-agents` config (`~/.pi/acp-agents/config.json`) uses a flat
`agent_servers: Record<string, AcpAgentConfig>` map, mirroring Zed's pattern.
The key is the alias name; the value carries `command/args/env/cwd` (transport)
plus optional `default_model/default_mode/systemPrompt` (persona). PR #17 added
`systemPrompt` (resolved by content shape at spawn time). The just-shipped
multi-alias setup (`pi`, `verifier`, `coder`, `browser-tester`, `red`,
`general`) exposed a usability gap: there is no `description` field, so an
operator invoking `acp_delegate { agent: "red" }` cannot tell from any listing
surface what RED does or when to choose it over `coder` or `general`.

Concurrently the conceptual model is muddy: `agent_servers` reads like a list
of *servers*, but the entries that share one binary (`pi-acp`) are really
*profiles* (persona + prompt + narrower goal) layered on top of a shared
server. The data model already supports this — multiple keys point at the same
`command` — but the type name, code comments, and docs do not articulate the
distinction, which caused confusion during the alias setup session.

Current code touchpoints (verified):
- `src/config/types.ts` `AcpAgentConfig` — schema source of truth (local).
- `packages/pi-acp-types/src/index.ts` — published types mirror (parity
  precedent: `systemPrompt` was added to both in PR #17).
- `src/config/config.ts` `validateConfig` — validates each entry.
- `src/settings/agents-command.ts` — `/acp agents` listing.
- `src/settings/agent-config-tui.ts` — TUI editor.
- `index.ts` — `showAcpConfig` / `showAcpDoctor` / status payloads.

## Goals / Non-Goals

**Goals:**
- Add `description?: string` to `AcpAgentConfig` (local + published types) with
  validation (string when present) and zero breaking change to existing configs.
- Surface `description` in every agent-listing surface (CLI command, status
  payloads, TUI editor) with graceful `(no description)` placeholder.
- Articulate the server-vs-profile model in code comments + AGENTS docs so the
  next operator setting up aliases understands the layering without reading the
  resolver source.
- Backfill descriptions for the 7 canonical aliases in the repo's example
  config + docs.

**Non-Goals:**
- No new top-level `profiles:` key. Profiles stay under `agent_servers`; the
  distinction is conceptual + documented, not a schema split. (Splitting would
  break every existing config and buy nothing — the data shape already supports
  the model.)
- No length cap enforced in code (guidance: ≤120 chars; tools may truncate).
- No auto-generation of descriptions from `systemPrompt` content (unreliable;
  operator-authored is sharper).
- No internationalization, no markdown rendering of descriptions (plain text).
- No migration of the `agent_servers` key name (would be a breaking rename).

## Decisions

### D1: Single optional `description?: string` field on `AcpAgentConfig`

**Choice:** Add `description?: string` directly on `AcpAgentConfig`, mirrored
to `packages/pi-acp-types/src/index.ts`.

**Rationale:** Matches the `systemPrompt` precedent (PR #17) — single field,
both type locations, additive, optional. Avoids introducing a nested
`{ description, longDescription, category }` object that would over-engineer a
≤1-line use case.

**Alternatives considered:**
- *Nested metadata object* — rejected: YAGNI; one field is enough for v1.
- *Separate `descriptions:` top-level map keyed by agent name* — rejected:
  splits the source of truth, drifts from the entry it describes.
- *Derive description from `default_mode` / `systemPrompt` first line* —
  rejected: brittle, surprises operators, breaks when prompt is a file path.

### D2: Validate type-only, no length cap

**Choice:** `validateConfig` rejects non-string `description` (throw naming the
agent). No `maxLength` check in code.

**Rationale:** Guidance ("≤120 chars") lives in docs/comments; tools truncate
for display. A code cap would arbitrarily reject valid operator intent and add
a test surface for zero behavioral gain.

**Alternatives considered:**
- *Hard cap at 200 chars* — rejected: arbitrary, breaks long-but-useful
  descriptions, adds validation tests for no real protection.
- *Warning on >120 chars* — rejected: validation is currently throw-or-pass;
  introducing a warning channel for one field is inconsistent.

### D3: Surface in all listing surfaces, placeholder for missing

**Choice:** Every surface that lists agents (`/acp agents`, `acp_status`,
`acp_runtime_info`, `acp_doctor`) includes `description` per row. Missing →
`(no description)` placeholder in human-readable surfaces; `undefined` in
machine-readable payloads.

**Rationale:** Consistency — operators learn one shape. Placeholder makes
"missing" visible without crashing.

### D4: TUI editor — clear = remove key, not empty string

**Choice:** Agent-config TUI treats an empty description input as "remove the
key" on save (write config without the `description` field), not as
`description: ""`.

**Rationale:** Round-trip parity with `loadConfig` semantics (absent ≡
undefined). Empty string would survive a load→save cycle as a visible
`""` in the file, which is noise.

**Alternatives considered:**
- *Persist empty string* — rejected: noisy config, surprising diff.

### D5: Conceptual model in comments + AGENTS, no rename

**Choice:** Update the `AcpAgentConfig` docblock and AGENTS.md to articulate:
"Each entry is an **agent profile** — a named persona (prompt + goal +
description) layered on a **server** (command/args/env/cwd). Multiple profiles
may share one server." Do NOT rename `agent_servers` (would break configs).

**Rationale:** The data model already supports the distinction; only the
vocabulary was missing. Renaming the key is a breaking change with no payoff.

## Risks / Trade-offs

- **[Risk] Description drifts from actual behavior as persona evolves** →
  Mitigation: doc guidance "update description when you change systemPrompt";
  no automated sync (intentional — operator-authored is sharper).
- **[Risk] Operators put secrets / long content in description and it leaks
  into logs/status payloads** → Mitigation: doc warning "do not put secrets in
  description; it is surfaced in listings"; status payloads already may be
  logged, so this is operator responsibility, not a new channel.
- **[Risk] Type parity drift between `src/config/types.ts` and
  `packages/pi-acp-types/src/index.ts`** → Mitigation: add both in the same
  PR; add a parity test (precedent: `systemPrompt` parity test exists from
  PR #17, extend it to cover `description`).
- **[Trade-off] Conceptual-only server/profile split (no schema rename) may
  still confuse readers who skim past comments** → Accepted: rename cost
  (breaking every config) >> residual confusion cost (a doc read).

## Migration Plan

1. Ship the field additively (optional, defaults undefined). No existing config
   breaks.
2. Backfill descriptions in the canonical example config under this repo's
   docs and `~/.pi/acp-agents/config.json` (operator's machine — manual, not
   auto-migrated).
3. No data migration script needed — field is purely additive.
4. **Rollback:** revert the PR; configs that added `description` continue to
   load (validateConfig ignores unknown fields via the `[key: string]: unknown`
   index signature on `AcpAgentConfig`). Zero data loss.

## Open Questions

- Should `acp_spawn` accept a one-shot `description` override at spawn time?
  (Current answer: no — spawn-time overrides fragment the source of truth; if
  needed later, add then.) **Deferring.**
- Should the TUI chooser (when one exists) group profiles by underlying
  server? (Current answer: no — operators think in profiles, not servers.)
  **Deferring until a chooser TUI is built.**

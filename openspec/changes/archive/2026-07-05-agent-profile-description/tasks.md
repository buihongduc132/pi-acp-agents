## 1. Type layer (schema source of truth)

- [x] 1.1 Add `description?: string` to `AcpAgentConfig` in `src/config/types.ts` with a docblock articulating the agent-profile-vs-server model (profile = persona+prompt+goal+description; server = command/args/env/cwd; multiple profiles may share one server)
- [x] 1.2 Mirror `description?: string` into `packages/pi-acp-types/src/index.ts` (published types) with the same docblock
- [x] 1.3 Extend the existing types-parity test (from PR #17) to assert `description` exists on both `AcpAgentConfig` definitions

## 2. Config validation

- [x] 2.1 In `src/config/config.ts` `validateConfig`, reject non-string `description` with an error naming the offending agent ("description must be a string on agent \"<name>\""); allow absent/undefined; do NOT enforce a length cap
- [x] 2.2 Add unit tests: config with `description` loads; config without loads; non-string `description` throws with agent name in message
- [x] 2.3 Run `npx vitest run test/config*.test.ts` → 0 failures

## 3. Listing surfaces

- [x] 3.1 `src/settings/agents-command.ts` `/acp agents` — print one row per profile with name, server command, and description (or `(no description)` placeholder)
- [x] 3.2 `index.ts` `showAcpConfig` / `showAcpDoctor` — include `description` in the printed payload; `acp_status` payload carries `description` per agent (string when set, absent when not)
- [x] 3.3 Add/update unit tests for `/acp agents` output and status payload shape

## 4. Agent-config TUI editor

- [x] 4.1 `src/settings/agent-config-tui.ts` — add an editable `description` text input to the profile editor
- [x] 4.2 Saving with a non-empty description persists the string; saving with an empty input removes the `description` key from the entry (not `null`, not `""`)
- [x] 4.3 Add a TUI round-trip test: edit → save → reload → assert description present; clear → save → reload → assert key absent

## 5. Docs + canonical example

- [x] 5.1 Update AGENTS.md with a short "Agent profiles vs servers" section articulating the model and listing the 7 canonical aliases with their descriptions
- [x] 5.2 Add a canonical example config (under `docs/` or `flow/`) showing all 7 aliases with `description` fields populated
- [x] 5.3 Backfill `description` into the operator's live `~/.pi/acp-agents/config.json` for the 7 existing aliases (manual; document in `_STATE.md` per project convention)

## 6. Verification gate (per spec scenarios)

- [x] 6.1 Map each spec scenario in `specs/agent-profiles/spec.md` to a test case; confirm every scenario has at least one passing test
- [x] 6.2 `npx tsc --noEmit` → exit 0
- [x] 6.3 `npx vitest run` → 0 failures (full suite)
- [x] 6.4 New files ≥80% line coverage (`npx vitest run --coverage` on the touched test files)
- [x] 6.5 Manual smoke: `/acp agents` shows descriptions; editing via TUI round-trips; clearing removes the key

## 7. PR workflow (verifier-loop + pr-creation skill)

- [x] 7.1 Pre-PR verifier comrade reviews work against proposal + specs (≥1 fresh verifier)
- [x] 7.2 Push branch, open PR, sleep ≥5 min (foreground), resolve every valid remote comment in fix→re-verify loop
- [x] 7.3 Final verifier comrade approves the whole work + PR
- [x] 7.4 Merge to `main`; `git checkout main && git pull && npx vitest run` confirms main green

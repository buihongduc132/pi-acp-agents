## 1. Foundation prerequisites (block until add-curator-lifecycle + add-curator-signal land)

> This proposal is EARLY-STAGE. Tasks 1.1–1.3 verify the foundations exist
> before any cross-check code is written. Names below are placeholders aligned
> with current research and MUST be re-validated against the landed proposals.

- [ ] 1.1 Confirm `add-curator-lifecycle` has shipped and exposes a persona
  schema with an extensible `crossCheck` field (optional, defaulting to
  disabled). If the persona schema is closed, open a follow-up to add the field.
- [ ] 1.2 Confirm `add-curator-signal` has shipped `signal_main` with a
  `severity` field and an enum. If `severity` is absent, drop the
  `critical-only` trigger mode from this change (see Open Question #3 in
  design.md) and update spec.md + design.md accordingly.
- [ ] 1.3 Confirm the `<mainSessionId>` source with `add-curator-lifecycle`
  (forked session id vs stable alias). Lock the mailbox path scheme in design.md
  once known.

## 2. Mailbox path + atomic append primitive

- [ ] 2.1 Define a `findMailboxPath(mainSessionId)` helper returning
  `~/.pi-curator/findings/<mainSessionId>/shared.jsonl`. Lazily `mkdir -p` the
  directory on first append.
- [ ] 2.2 Implement `appendEntry(path, entry)` writing one JSON line + newline
  using `O_APPEND` (fs.open with flag `'a'`). Cap entry size at 4 KiB and
  truncate the `summary` field if needed to stay under the limit.
- [ ] 2.3 Implement `readEntries(path)` returning parsed JSON objects, skipping
  unparseable lines (do NOT throw — see fail-open requirement). Return `[]` if
  file missing.

## 3. Topic + dedup logic

- [ ] 3.1 Implement `normalizeTopic(raw)` = lowercased, trimmed string. No fuzzy
  match, no embedding.
- [ ] 3.2 Implement `findRecentFinding(entries, topic, windowMinutes, nowIso)`
  returning the most recent `finding` entry for `topic` within the window, or
  `null`.
- [ ] 3.3 Construct `finding` and `agreement` JSON line shapes exactly as
  specified in `specs/curator-crosscheck/spec.md` (Requirement: First-finding-
  wins dedup with append-agreement).

## 4. Cross-check hook on signal_main

> This is the only integration point. No new tool, no new daemon.

- [ ] 4.1 Add a pre-`signal_main` hook in the curator that:
  - Reads `persona.crossCheck.enabled`; if false, calls `signal_main` and
    returns.
  - Reads `persona.crossCheck.trigger`; if `"critical-only"` and severity !=
    `"critical"`, calls `signal_main` and returns.
  - Otherwise proceeds to 4.2.
- [ ] 4.2 Inside the hook, run the dedup:
  - Compute `topic` via `normalizeTopic`.
  - `readEntries(mailbox)` (fail-open on any error → skip to signal).
  - `findRecentFinding(...)`. If non-null → append `agreement` entry (fail-open
    on error), do NOT call `signal_main`, return.
  - If null → call `signal_main`, then append `finding` entry (fail-open on
    error; signal already went out).
- [ ] 4.3 Wrap the entire hook in a try/catch that logs at debug level and
  proceeds to `signal_main` independently. Verify NO code path can propagate an
  exception into the curator main loop. (This is the fail-open mandate; see
  spec.md Requirement: Cross-check failures MUST fail open.)

## 5. Persona config wiring

- [ ] 5.1 Document the `crossCheck.{enabled, mode, trigger, windowMinutes}`
  shape in the persona schema reference of `add-curator-lifecycle` (or open a
  follow-up delta to that change if it has already archived).
- [ ] 5.2 Add a JSON-schema fragment for `crossCheck` with the defaults:
  `enabled: false`, `mode: "append-agreement"`, `trigger:
  "before-every-signal"`, `windowMinutes: 10`.
- [ ] 5.3 Validate that loading a persona with NO `crossCheck` field behaves
  identically to `crossCheck.enabled = false` (Requirement: opt-in and defaults
  to disabled).

## 6. Scope enforcement

- [ ] 6.1 Verify the mailbox path is derived ONLY from the curator's own
  `<mainSessionId>` (received at spawn). Confirm there is no code path that
  enumerates other main sessions' directories.
- [ ] 6.2 Add a grep-level guard in CI/review: no reference to other
  `<mainSessionId>` paths, no `readdir` of `~/.pi-curator/findings/`.

## 7. Lifecycle / GC integration

- [ ] 7.1 Register `~/.pi-curator/findings/<mainSessionId>/` in the GC list of
  the daemon from `add-curator-lifecycle` so the mailbox is removed when the
  main session is garbage-collected.
- [ ] 7.2 Verify cross-session isolation: removing `findings/m1/` does not touch
  `findings/m2/`.

## 8. Tests (fail-open is the critical path)

- [ ] 8.1 Unit: `appendEntry` then `readEntries` round-trips a `finding` and an
  `agreement`.
- [ ] 8.2 Unit: `findRecentFinding` honors `windowMinutes` (entry at +9 min
  matches, entry at +11 min does not).
- [ ] 8.3 Unit: `findRecentFinding` is case-insensitive on `topic`.
- [ ] 8.4 Unit: malformed JSON line in mailbox is skipped, not thrown.
- [ ] 8.5 Integration: two curator stubs on the same main session, same topic →
  first signals + appends finding, second appends agreement + does not signal.
- [ ] 8.6 Integration: two curator stubs on different `<mainSessionId>`s, same
  topic → both signal (isolation enforced).
- [ ] 8.7 **Critical:** fail-open test. Make mailbox unreadable (chmod 000) →
  curator MUST still call `signal_main` and MUST NOT throw.
- [ ] 8.8 **Critical:** fail-open test. Force append to throw (full disk stub)
  → curator MUST still call `signal_main` (signal already sent in
  `append-agreement` mode before append is attempted for the first finder; for
  the second finder the dedup is skipped on read error).
- [ ] 8.9 Mode `signal-anyway`: matching finding in mailbox → curator still
  signals AND appends a new finding (not an agreement).
- [ ] 8.10 Trigger `critical-only`: non-critical severity → cross-check skipped,
  signal proceeds regardless of mailbox state.

## 9. Out-of-scope guards (verifier checklist)

> These tasks exist to make the non-goals auditable. They should NOT be
> implemented — they should be verified ABSENT.

- [ ] 9.1 Verify NO vote-counting, quorum, or weighted aggregation code exists.
- [ ] 9.2 Verify NO LLM call is made to resolve disagreements between curators.
- [ ] 9.3 Verify NO API enumerates or reads other main sessions' mailboxes.
- [ ] 9.4 Verify NO retry, backoff, or blocking wait exists in the cross-check
  path.
- [ ] 9.5 Verify NO dependency on the email-bus (it is WIP per locked decision).

## 10. Rollout

- [ ] 10.1 Ship behind `crossCheck.enabled = false` default. No migration
  needed.
- [ ] 10.2 Document the lean default (file mailbox + first-finding-wins) and the
  rejected alternatives (pi-intercom curator→curator, aggregation daemon) in the
  user-facing curator docs, citing design.md D1.
- [ ] 10.3 Rollback drill: remove the pre-`signal_main` hook and confirm
  curators revert to fully independent signaling with no broken state.

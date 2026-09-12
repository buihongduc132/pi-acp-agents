## ADDED Requirements

### Requirement: Curator cross-check is opt-in and defaults to disabled

The system SHALL provide a per-persona `crossCheck` config field on the curator
persona schema defined by `add-curator-lifecycle`. The default value of
`crossCheck.enabled` SHALL be `false`. When disabled, a curator SHALL behave
exactly as if this capability does not exist (no mailbox reads, no appends, no
dedup).

The `crossCheck` field SHALL expose at minimum:
- `enabled: boolean` (default `false`)
- `mode: "append-agreement" | "signal-anyway"` (default `"append-agreement"`)
- `trigger: "before-every-signal" | "critical-only"` (default `"before-every-signal"`)
- `windowMinutes: number` (default `10`) — dedup window for matching peer findings

#### Scenario: Cross-check disabled by default
- **WHEN** a curator persona is loaded with no `crossCheck` field
- **THEN** the curator SHALL NOT read or write any shared findings mailbox
- **AND** every finding SHALL be signaled to main independently

#### Scenario: Opt-in via persona config
- **WHEN** a curator persona sets `crossCheck.enabled = true`
- **THEN** the curator SHALL perform the cross-check protocol described in the
  requirements below before each applicable `signal_main`

### Requirement: Cross-check scope is restricted to the same main session

The system SHALL key the shared findings mailbox by `<mainSessionId>`. A
curator SHALL only read findings written by curators attached to the SAME main
session. The system SHALL NOT provide any API, file path, or enumeration that
exposes findings from curators attached to a different main session.

The mailbox path SHALL be of the form
`~/.pi-curator/findings/<mainSessionId>/shared.jsonl` and SHALL be created
lazily on first append.

#### Scenario: Curators on the same main session see each other
- **WHEN** curator A and curator B are both attached to main session `m1`
- **AND** curator A appends a finding to `~/.pi-curator/findings/m1/shared.jsonl`
- **THEN** curator B's next cross-check read SHALL observe curator A's finding

#### Scenario: Curators on different main sessions are isolated
- **WHEN** curator A is attached to main session `m1`
- **AND** curator C is attached to main session `m2`
- **THEN** curator A's cross-check SHALL NOT read any file under
  `~/.pi-curator/findings/m2/`
- **AND** there SHALL be no API to list or discover other main sessions'
  findings directories

### Requirement: First-finding-wins dedup with append-agreement

The system SHALL implement a first-finding-wins deduplication rule for the `append-agreement` mode (the default). When `crossCheck.mode` is `"append-agreement"`, before a curator
calls `signal_main` for a finding with topic `T`, it SHALL read the shared
mailbox for its main session. If the mailbox contains a `finding` entry with
topic `T` whose timestamp is within `crossCheck.windowMinutes` minutes of the
current time, the curator SHALL:

1. NOT call `signal_main` for this finding.
2. Append an `agreement` entry to the same mailbox referencing topic `T`.

If no matching `finding` entry exists within the window, the curator SHALL call
`signal_main` normally and then append a new `finding` entry for topic `T`.

A finding entry SHALL be a single JSON line of the form:
`{"type":"finding","topic":"<slug>","curator":"<alias>","ts":"<iso>","severity":"<sev>","summary":"<text>"}`

An agreement entry SHALL be a single JSON line of the form:
`{"type":"agreement","topic":"<slug>","curator":"<alias>","ts":"<iso>","severity":"<sev>"}`

Topic matching SHALL be exact, case-insensitive, after trimming surrounding
whitespace. No fuzzy matching, embedding search, or canonicalization SHALL be
performed.

#### Scenario: First curator signals, subsequent curators agree silently
- **WHEN** curator A reads an empty mailbox for topic `T`
- **THEN** curator A SHALL call `signal_main` for topic `T`
- **AND** curator A SHALL append a `finding` entry for topic `T` to the mailbox

- **WHEN** curator B subsequently reads the mailbox for topic `T`
- **AND** the `finding` entry from curator A is within `windowMinutes`
- **THEN** curator B SHALL NOT call `signal_main` for topic `T`
- **AND** curator B SHALL append an `agreement` entry for topic `T`

#### Scenario: Divergent topics both signal
- **WHEN** curator A extracts topic `failing-ci`
- **AND** curator B extracts topic `red-build` for what is conceptually the same issue
- **THEN** both curators SHALL call `signal_main`
- **AND** the mailbox SHALL contain two `finding` entries with distinct topics

#### Scenario: Expired finding does not dedup
- **WHEN** the most recent `finding` entry for topic `T` is older than
  `crossCheck.windowMinutes` minutes
- **THEN** the curator SHALL treat topic `T` as unmatched
- **AND** the curator SHALL call `signal_main` and append a new `finding` entry

### Requirement: signal-anyway mode preserves signals but records findings

When `crossCheck.mode` is `"signal-anyway"`, the curator SHALL always call
`signal_main` for its finding, and SHALL additionally append a `finding` entry
to the mailbox. This mode provides observability of peer findings without
suppressing any curator's signal.

#### Scenario: signal-anyway mode does not suppress
- **WHEN** a curator persona sets `crossCheck.enabled = true` and
  `crossCheck.mode = "signal-anyway"`
- **AND** the mailbox already contains a matching `finding` for the same topic
- **THEN** the curator SHALL STILL call `signal_main`
- **AND** the curator SHALL append a new `finding` entry (NOT an agreement)

### Requirement: Trigger restricts when cross-check runs

The system SHALL restrict when cross-check runs based on the `crossCheck.trigger` config. When `crossCheck.trigger` is `"critical-only"`, the cross-check read/dedup
SHALL run only when the would-be signal has `severity === "critical"`. For all
other severities, the curator SHALL skip cross-check entirely and signal
independently. When `crossCheck.trigger` is `"before-every-signal"` (the
default), cross-check SHALL run before every signal regardless of severity.

#### Scenario: before-every-signal runs always
- **WHEN** `crossCheck.trigger === "before-every-signal"`
- **THEN** cross-check SHALL run before every call to `signal_main`

#### Scenario: critical-only skips non-critical
- **WHEN** `crossCheck.trigger === "critical-only"`
- **AND** the would-be signal has severity `"high"`
- **THEN** the curator SHALL skip the cross-check read
- **AND** the curator SHALL call `signal_main` immediately

### Requirement: Cross-check failures MUST fail open and never block

The system SHALL treat all cross-check failures as non-blocking and MUST degrade to independent signaling on any error. Any error encountered during cross-check (file missing, parse failure, permission denied, disk full, I/O error) SHALL be caught and logged at debug
level only. The curator SHALL then proceed to call `signal_main` as if
cross-check were disabled. No error from cross-check SHALL propagate to the
curator's main loop, SHALL trigger a retry, SHALL introduce a delay, or SHALL
block `signal_main` under any circumstance.

This requirement is non-negotiable and reflects the locked user decision that
cross-check MUST degrade to independent signaling when the channel is down.

#### Scenario: Mailbox read failure falls back to independent signal
- **WHEN** the shared mailbox file does not exist or is unreadable
- **THEN** the curator SHALL log at debug level
- **AND** the curator SHALL proceed to call `signal_main` for its finding

#### Scenario: Mailbox parse failure falls back to independent signal
- **WHEN** the shared mailbox contains a malformed JSON line
- **THEN** the curator SHALL NOT throw
- **AND** the curator SHALL treat the file as having no matching findings
- **AND** the curator SHALL call `signal_main` and append a new `finding` entry

#### Scenario: Mailbox append failure falls back to independent signal
- **WHEN** appending a `finding` or `agreement` entry fails for any reason
- **THEN** the curator SHALL NOT block or retry
- **AND** the curator SHALL have already called (or shall still call)
  `signal_main` for the finding

### Requirement: Append-only mailbox with atomic line writes

The shared findings mailbox SHALL be append-only. Each entry SHALL be a single
JSON object followed by a newline, written using POSIX `O_APPEND` semantics so
that concurrent appends from multiple curator processes do not interleave within
a line. The system SHALL NOT require file locking for v1; entries SHALL be kept
under 4 KiB to stay within the POSIX atomic-write guarantee.

#### Scenario: Concurrent appends do not corrupt lines
- **WHEN** curator A and curator B append entries simultaneously
- **THEN** the mailbox SHALL contain two complete, parseable JSON lines
- **AND** no line SHALL contain fragments of both entries

### Requirement: Mailbox lifecycle is bound to the main session

The shared findings mailbox for a given `<mainSessionId>` SHALL be removed when
the corresponding main session's curator state is garbage-collected by the
daemon from `add-curator-lifecycle`. The system SHALL NOT retain, archive, or
expose findings beyond the lifetime of their main session.

#### Scenario: Mailbox removed on session GC
- **WHEN** the daemon garbage-collects the state for main session `m1`
- **THEN** the directory `~/.pi-curator/findings/m1/` SHALL be removed
- **AND** no other main session's findings SHALL be affected

### Requirement: No consensus, voting, or cross-session visibility

The system SHALL NOT implement quorum, majority voting, severity-weighted
voting, conflict-resolution via LLM, or any cross-session visibility between
curators attached to different main sessions. Curators SHALL NOT exchange
replies, acknowledgements, or read-receipts with each other. The only
peer-to-peer data a curator reads is the append-only shared mailbox for its own
main session.

This requirement exists to prevent gold-plating and to keep the implementation
within the lean-default scope mandated by the locked user decisions.

#### Scenario: No voting primitive exists
- **WHEN** any task or implementation attempts to introduce a vote count,
  quorum threshold, or weighted aggregation
- **THEN** that work SHALL be rejected as out of scope for this capability

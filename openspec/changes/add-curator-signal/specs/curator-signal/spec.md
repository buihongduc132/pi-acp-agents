## ADDED Requirements

### Requirement: T0 probe MUST run before any transport REQ is treated as hard
The change SHALL ship a blocking T0 probe as task #1 (see tasks.md). Until T0
records its findings, every transport REQ below (REQ-SG-02 through REQ-SG-08)
SHALL be treated as CONDITIONAL with the documented fallback in design.md
sections D-C2/C4, D-C3, and D-FALLBACK-FILE. T0 MUST probe at minimum: (a)
whether `pi-intercom` forwards full `details` including a curator-supplied
`kind` field; (b) what `customType` the receiver's hook actually sees
(expected: hardcoded `intercom_message`, making top-level customType filtering
non-viable); (c) whether the non-interactive busy auto-reply in
`pi-intercom/index.ts:670-687` fires BEFORE any extension hook. T0 results
SHALL be written to `~/.pi-curator/probes/t0-results.md` and referenced by the
implementer of every downstream REQ.

#### Scenario: T0 runs and records findings before any transport code is shipped
- **WHEN** the implementer begins REQ-SG-02 through REQ-SG-08
- **THEN** a T0 probe results file exists at `~/.pi-curator/probes/t0-results.md`
  answering (a) details passthrough, (b) observed customType, (c) auto-reply
  hook ordering
- **AND** each downstream REQ cites which T0 answer resolved its CONDITIONAL
  status

#### Scenario: T0 not yet run
- **WHEN** T0 results file does not exist
- **THEN** no transport REQ SHALL be marked DONE in tasks.md
- **AND** the implementer SHALL run T0 first

### Requirement: Curator chooses kind per finding via prose prompt
The curator prose prompt SHALL instruct the curator LLM that it has two
delivery modes — `steer` (force a turn / queue mid-turn) and `append` (pure
ambient context) — and SHALL instruct the curator to choose the mode per
finding based on urgency and actionability (NOT preconfigured to one mode).
The prose prompt is owned by `add-curator-lifecycle` and cross-referenced
here; this change defines only the signal semantics. The kind SHALL be
encoded in the message body as a text prefix `[STEER] ` or `[APPEND] `
(default path honoring locked decision D-H10).

#### Scenario: Curator emits a steer finding
- **WHEN** the curator LLM decides a finding requires main attention
- **THEN** it sends via stock `intercom({action:"send", to:<main-name>})` with
  message body beginning with the literal prefix `[STEER] `

#### Scenario: Curator emits an append finding
- **WHEN** the curator LLM decides a finding is non-urgent ambient context
- **THEN** it sends via stock `intercom({action:"send", to:<main-name>})` with
  message body beginning with the literal prefix `[APPEND] `

### Requirement: Main-side receiver filters curator signals by sender, not customType
The main-side receiver extension SHALL identify curator-originated intercom
messages by matching the sender's session identity (provided by
`add-curator-lifecycle`'s curator list for this main session) against the
delivered message's sender info. The receiver SHALL NOT filter on top-level
`customType === "curator_signal"` (which matches nothing because pi-intercom
hardcodes `customType:"intercom_message"` on re-emit). The receiver SHALL
ignore any intercom message whose sender is not a known curator for this main
session.

#### Scenario: Known curator sends a signal
- **WHEN** an intercom message arrives whose sender matches a curator in this
  main's curator list
- **THEN** the receiver processes the message per REQ-SG-04 and REQ-SG-05

#### Scenario: Unknown sender
- **WHEN** an intercom message arrives whose sender is not a known curator for
  this main session
- **THEN** the receiver ignores it (no turn triggered, no exception thrown)

### Requirement: Kind recovery from message (CONDITIONAL on T0)
The receiver SHALL recover the `kind` from the delivered message using, in
priority order: (i) parse the `[STEER]` / `[APPEND]` text prefix from the
delivered body text; (ii) if the prefix is missing or stripped, read
`details.kind` directly (only if T0 confirms `details` passthrough); (iii) if
both fail, switch to the D-H10-FALLBACK path (curator-side custom
`signal_main` tool emitting `customType:"curator_signal_steer"` /
`"curator_signal_append"`, with an explicit D-H10-DEVIATION Decision Log entry
added to design.md). The receiver SHALL treat an unrecoverable kind as
`steer` (safe default — forces attention rather than dropping the finding).

#### Scenario: Prefix parsing succeeds (primary path)
- **WHEN** the delivered body text begins with `[STEER] ` or `[APPEND] `
- **THEN** the receiver recovers the kind from the prefix

#### Scenario: Prefix missing, details.kind present
- **WHEN** the body prefix is absent AND `details.kind` is present AND T0
  confirmed `details` passthrough
- **THEN** the receiver recovers the kind from `details.kind`

#### Scenario: Both prefix and details.kind fail
- **WHEN** neither prefix parsing nor `details.kind` yields a kind
- **THEN** the implementer switches to D-H10-FALLBACK and adds a
  D-H10-DEVIATION Decision Log entry to design.md before proceeding
- **AND** the receiver treats unrecoverable kind as `steer` until the
  fallback ships

### Requirement: Steer delivery semantics
For a recovered `kind === "steer"`, the receiver SHALL re-deliver the finding
to the main session via `pi.sendMessage({customType:"curator_steer", content,
display:true}, {triggerTurn:true, deliverAs:"steer"})`. This wakes an idle
main and queues mid-turn for delivery after the current turn's tool calls.

#### Scenario: Steer wakes idle main
- **WHEN** main is idle and a curator `steer` arrives
- **THEN** the receiver calls `pi.sendMessage` with `triggerTurn:true`
- **AND** main begins a new turn

#### Scenario: Steer queues mid-turn
- **WHEN** main is mid-turn (streaming or running tools) and a curator `steer`
  arrives
- **THEN** the receiver calls `pi.sendMessage` with `deliverAs:"steer"`
- **AND** the finding is delivered after the current turn's tool calls,
  before the next LLM call

### Requirement: Append delivery semantics (pure ambient, no turn)
For a recovered `kind === "append"`, the receiver SHALL re-deliver the finding
via `pi.sendMessage({customType:"curator_append", content,
display:<persona config, default false>}, {deliverAs:"nextTurn"})`. The
receiver SHALL NOT pass `triggerTurn:true` for append. The receiver SHALL NOT
use `deliverAs:"followUp"` for append (it stalls forever against an idle
agent per todo-enforcer `index.ts:200-212`).

#### Scenario: Append does not trigger a turn
- **WHEN** a curator `append` arrives and main is idle
- **THEN** the receiver calls `pi.sendMessage` with `deliverAs:"nextTurn"` and
  no `triggerTurn`
- **AND** no new turn begins
- **AND** the finding surfaces on the next user prompt

#### Scenario: Append default display is false
- **WHEN** a curator `append` arrives and the persona config does not specify
  display
- **THEN** the re-delivered message has `display:false`

### Requirement: Non-interactive main uses fallback file as primary
The curator SHALL use a fallback findings file as the PRIMARY delivery path
when main runs in non-interactive mode (`ctx.mode === "rpc"`). In that mode
the intercom receiver path is unreachable (pi-intercom `index.ts:670-687`
auto-replies before any hook fires — verifier C3). The curator prose prompt
SHALL branch: non-interactive → write findings to
`~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl`; interactive →
use intercom. Main's `/curator status` (owned by `add-curator-lifecycle`,
cross-referenced) SHALL read and surface the file.

#### Scenario: Main is non-interactive
- **WHEN** main runs as `pi -p` / RPC mode
- **THEN** the curator writes findings to the fallback findings file
- **AND** does not rely on intercom delivery
- **AND** `/curator status` surfaces the file contents

#### Scenario: Main is interactive
- **WHEN** main runs interactively (TUI)
- **THEN** the curator uses intercom per REQ-SG-02 through REQ-SG-06

### Requirement: Broker-unreachable fallback
The curator SHALL retry an unreachable intercom broker exactly ONCE before
falling back. When the intercom broker is unreachable (send fails or delivery
never arrives), the curator retries the send (the broker auto-spawns on first
connect per `pi-intercom/broker/spawn.ts`). On second failure the curator
SHALL write the finding to the same fallback findings file as REQ-SG-07
(`~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl`).

#### Scenario: Broker transiently unavailable then recovers
- **WHEN** the first intercom send fails
- **THEN** the curator retries once
- **AND** if the retry succeeds the finding is delivered via intercom

#### Scenario: Broker unavailable on retry
- **WHEN** the retry also fails
- **THEN** the curator writes the finding to the fallback findings file
- **AND** `/curator status` surfaces it

### Requirement: Receiver is exception-safe and never blocks main
The receiver extension SHALL wrap all message handling in try/catch. On any
exception the receiver SHALL log to UI only (`ui.notify` /
`ui.setStatus`, `display:false`) and SHALL NOT re-throw, SHALL NOT block the
main turn, and SHALL NOT crash the main session. A malformed curator signal
SHALL be dropped after logging, not fatal.

#### Scenario: Receiver throws during handling
- **WHEN** the receiver encounters an exception while processing a curator
  signal
- **THEN** the exception is caught
- **AND** a UI-only notification is shown
- **AND** the main turn continues unaffected

#### Scenario: Malformed curator signal
- **WHEN** a curator signal cannot be parsed (missing body, no recoverable
  kind, malformed JSON in details)
- **THEN** the signal is dropped after a UI-only log
- **AND** no exception propagates to the main turn

### Requirement: Session-targeting verification
The receiver SHALL verify that the delivered message's `mainSessionId` (or
sender's known mainSessionId from lifecycle) matches the current main
session's id BEFORE acting. A curator signal meant for a different main
session SHALL be ignored (curators are 1-per-main by default; cross-session
scope is deferred).

#### Scenario: Signal targets this main
- **WHEN** the delivered message's mainSessionId equals this main's session id
- **THEN** the receiver processes it

#### Scenario: Signal targets a different main
- **WHEN** the delivered message's mainSessionId does not equal this main's
  session id
- **THEN** the receiver ignores the message

### Requirement: No email-bus dependency
The signal layer SHALL depend only on `pi-intercom` and the local filesystem
(fallback file). It SHALL NOT depend on the email-bus (locked decision: WIP).
The email_pub/email_sub tools SHALL NOT be used in the curator→main path.

#### Scenario: Implementation avoids email-bus
- **WHEN** the signal layer is implemented
- **THEN** no code path calls `email_pub` or `email_sub` for curator→main
  delivery

### Requirement: Cross-reference add-curator-lifecycle (non-duplicate)
This change SHALL NOT define spawn, fork, pm2 namespace, janitor GC,
spawn-gate, persona config, context trim, non-bias filter, or the `/curator`
slash family. Those are owned by `add-curator-lifecycle`. This change
consumes (a) the `mainSessionId` that lifecycle stamps on each curator, and
(b) the curator session list that lifecycle exposes to the receiver. This
change's tasks.md SHALL cross-reference lifecycle's tasks where they
intersect.

#### Scenario: Lifecycle provides mainSessionId
- **WHEN** a curator is spawned by lifecycle
- **THEN** lifecycle stamps a `mainSessionId` the receiver can verify against

#### Scenario: Lifecycle provides curator session list
- **WHEN** the receiver needs to identify curator-originated messages
- **THEN** lifecycle exposes a curator list keyed by mainSessionId

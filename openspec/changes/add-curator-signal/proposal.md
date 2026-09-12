## Why

Curators run as separate out-of-process pi sessions (`add-curator-lifecycle`
spawns them). Once a curator forms a finding, it must push that finding back to
its spawning main session — either as a `steer` (force a new turn / queue
mid-turn) or as an `append` (pure ambient context, no turn). The locked user
decision is **"2 modes … curator decided the usage by themself"** and
**"child decide to intercom or not"** — the curator LLM, not preconfigured
config, chooses which mode each finding uses.

The hard part is the transport. A child pi process cannot call
`pi.sendMessage` on the parent (in-process only). The project already runs
`pi-intercom` as a broker over `~/.pi/agent/intercom/broker.sock` that solves
cross-process, session-targeted delivery with idle/busy/reconnect handling.
Reusing it avoids inventing a new IPC channel — but the receiver path is
**unverified against the actual intercom re-emit behavior**, and the prior
proposal (REJECTED Round 1) hand-wrote REQs against an IPC layer it never
probed (verifier C2/C3/C4). This change owns the signal/IPC layer only;
**T0 is a blocking probe** that resolves every conditional REQ.

## What Changes

- **NEW capability `curator-signal`**: end-to-end curator→main delivery path
  for `kind=steer|append` findings. Covers (a) the curator-side mechanism
  (prose-prompt + stock intercom tool, per locked decision, OR a documented
  deviation), (b) the main-side receiver extension that filters curator
  signals and maps each `kind` to the correct `deliverAs`/`triggerTurn`
  semantics, (c) T0 probe tasks that gate every transport REQ, (d) fallback
  paths for `details.kind` non-round-trip, non-interactive auto-reply
  interception, and broker-unreachable.

- **Transport: `pi-intercom` only.** No new IPC channel, no email-bus
  (explicitly WIP — locked decision). Broker already running.

- **T0 PROBE IS TASK #1 (blocking).** Before any transport REQ is claimed as
  hard MUST, this change ships a probe that verifies:
  1. Does pi-intercom forward full `details` (incl. curator's `kind`) on
     incoming delivery?
  2. What `customType` does the receiver see? (Research says pi-intercom
     HARDCODES `customType="intercom_message"` on re-emit at
     `~/.pi/agent/npm/node_modules/pi-intercom/index.ts:586-593`, so filtering
     on `customType === "curator_signal"` matches NOTHING.)
  3. When main is non-interactive (`pi -p`) AND busy, does
     `pi-intercom/index.ts:670-687` short-circuit with an auto-reply BEFORE any
     extension hook fires?

- **All transport REQs are CONDITIONAL with documented fallbacks** until T0
  resolves. No "IMPLEMENTATION NOTE: verify during build" — that is
  duty-evasion (verifier C2/C3).

- **Fallback if `details.kind` does NOT round-trip**: encode kind in the
  `customType` suffix (`curator_signal_steer` / `curator_signal_append`),
  which IS in the always-forwarded `customType` field.

- **Fallback for non-interactive auto-reply interception (verifier C3)**: pick
  ONE and mark in design — (a) patch pi-intercom to accept
  `skipAutoReplyFor: ["curator_signal"]`, OR (b) RPC-mode main → curator
  writes findings to fallback file
  `~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl` as PRIMARY
  path, OR (c) main extension subscribes at broker level (bypasses
  pi-intercom tool layer).

- **Receiver maps `kind` → delivery semantics:**
  - `steer` → `{triggerTurn:true, deliverAs:"steer"}` (wakes idle, queues
    mid-turn). Matches `todo-enforcer/index.ts:226-236`.
  - `append` → `{deliverAs:"nextTurn"}`, NO `triggerTurn` (pure ambient).
    `nextTurn` is chosen over `followUp` deliberately: `followUp` against an
    already-idle agent stalls forever (todo-enforcer
    `index.ts:200-212`), while `nextTurn` never triggers and never stalls.

- **Receiver MUST catch all exceptions, log to UI only, never block the main
  turn.** (Pi hook rule: receiver-side interception is opt-in-blocking; default
  non-blocking.)

- **Broker-unreachable fallback:** retry once (broker auto-spawns on first
  connect per `pi-intercom/broker/spawn.ts`), then curator writes the
  findings-fallback file; main `/curator status` surfaces it. Links to
  `add-curator-lifecycle` status surface.

### Out of scope (owned by `add-curator-lifecycle` / other changes)

- Spawn command, fork logic, pm2 namespace, janitor GC, spawn-gate, persona
  config, context trim, non-bias filter, `/curator` slash family shell.
  Those live in `add-curator-lifecycle`. This change consumes the
  main-session-id that lifecycle stamps and produces findings; it does not
  spawn, fork, or reap curators.
- Deferred: cross-check protocol (`add-pi-curator-crosscheck`), mailbox
  reader (`add-pi-curator-mailbox` — only if intercom insufficient after T0),
  email-bus dependency, thinking-inclusion policy.

## Capabilities

### New Capabilities
- `curator-signal`: End-to-end curator→main signal/IPC layer. Curator emits
  `kind=steer|append` findings; main-side receiver extension filters them and
  re-delivers with the correct `deliverAs`/`triggerTurn` per kind. T0 probe
  gates every transport REQ; fallbacks defined for the three known failure
  modes (non-round-tripping `kind`, non-interactive auto-reply interception,
  broker unreachable).

### Modified Capabilities
<!-- None. curator-signal is a brand-new capability. No existing openspec/specs/
capability is touched. (add-curator-lifecycle will introduce curator-lifecycle
in parallel; this change cross-refs it but does not modify its requirements.) -->

## Impact

- **Code** (target repo `pi-acp-agents`):
  - NEW extension: main-side `curator-receiver` (filters incoming curator
    signals, maps kind→delivery, verifies `details.mainSessionId ===
    this-session-id`). ~150-250 lines TS, mirroring the
    `deliverMessage`/`triggerTurn` patterns proven in
    `pi-plugins/profile/extensions/todo-enforcer/index.ts:213-237`.
  - Possibly NEW (conditional on T0): a small pi-intercom patch for
    `skipAutoReplyFor`, OR a fallback-file writer on the curator side. Pick
    path (a/b/c) in design after T0.
  - **Possibly NONE on curator side** if locked decision is honored verbatim
    (prose prompt + stock `intercom` tool). See design Decision Log entry D-H10.
- **Dependencies**:
  - HARD: `pi-intercom@0.6.0` broker (already running at
    `~/.pi/agent/intercom/broker.sock`). No new runtime dep.
  - HARD: depends on `add-curator-lifecycle` existing — this change consumes
    the mainSessionId and spawn lifecycle it produces. Cross-ref, do not
    duplicate.
  - NO email-bus dependency (locked decision: WIP, do not rely).
- **Risks**:
  - T0 may force path (b) (RPC fallback file as PRIMARY, not intercom). That
    changes the headline architecture; documented as CONDITIONAL here, decided
    in T0.
  - `append` delivery via `nextTurn` only surfaces on the *next user prompt*
    — findings sit ambient until the user types. This is by design (pure
    ambient) but worth surfacing so curators reserve `append` for non-urgent
    observations and `steer` for anything actionable.
  - "Hidden from delegated branches" claim about `display:false` is
    **UNVERIFIED** (verifier H9) — this change does NOT assert it as a hard
    REQ; it is left to T0/probe or dropped.

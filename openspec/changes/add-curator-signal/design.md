## Context

Curators are out-of-process pi sessions (spawned by `add-curator-lifecycle`).
They run a forked, trimmed copy of the main session's transcript, form
findings, and must push those findings back to the spawning main session. A
child pi process cannot reach the parent's `AgentSession` via the documented
extension API (`pi.sendMessage` / `pi.sendUserMessage` are in-process only —
see `curator-research-signal-main.md` §1). The project already runs
`pi-intercom@0.6.0` as a broker over `~/.pi/agent/intercom/broker.sock` that
solves cross-process, session-targeted delivery with idle/busy/reconnect
handling. This change owns the curator→main signal/IPC layer on top of that
broker.

**Two locked user decisions shape this design (verbatim):**
- "2 modes. A steer message, can invoke a new turn; or a append like in context
  message." + "it is not preconfigured, curator decided the usage by themself."
- "intercom will be in prose prompt like: 'you are in the sidecar of the
  session <name & id>. For all your tasks, if need to communicate to the main,
  use intercom'."

**Three load-bearing open questions block a hard design** (verifier C2/C3/C4
from the REJECTED Round 1 proposal). These are resolved by T0 (task #1, see
tasks.md) BEFORE any transport REQ is treated as hard MUST. Until T0 runs,
every transport REQ in `specs/curator-signal/spec.md` is CONDITIONAL with a
documented fallback.

Current state to probe against:
- pi-intercom `index.ts:586-593` — `sendIncomingMessage` re-emits with
  `customType: "intercom_message"` (HARDCODED) and `details: entry`
  (passthrough, flagged UNVERIFIED).
- pi-intercom `index.ts:670-687` — when recipient is busy AND non-interactive
  (`pi -p`), returns an auto-reply string BEFORE calling `pi.sendMessage`,
  so NO extension hook can intercept.
- pi-intercom `index.ts:662-700` — when recipient is interactive: idle →
  `sendIncomingMessage(entry, "trigger")` (`{triggerTurn:true}`); busy →
  queued in `pendingIdleMessages`, drained by `flushIdleMessages`.
- todo-enforcer `index.ts:213-237` — proven recipe for forcing a turn from an
  idle agent_end: `pi.sendMessage({customType,content,display},
  {triggerTurn:true, deliverAs:"steer"})`. Also documents the
  `followUp`-against-idle stall trap (`index.ts:200-212`).

## Goals / Non-Goals

**Goals:**
- End-to-end delivery of `kind=steer` and `kind=append` findings from a
  curator process to its spawning main session, with the curator LLM
  (not config) choosing the kind per finding.
- Reuse `pi-intercom` — no new IPC channel, no email-bus.
- The main-side receiver maps `kind` to the exact `deliverAs`/`triggerTurn`
  semantics, escaping the stock intercom tool's "always trigger when idle"
  behavior so `append` can be truly ambient.
- Every transport assumption is either proven by a T0 probe or has a
  concrete fallback path. No "verify during build" duty-evasion.
- Receiver is exception-safe and never blocks the main turn.

**Non-Goals:**
- Spawn, fork, pm2, janitor, persona config, context trim, non-bias filter
  — all owned by `add-curator-lifecycle`. This change consumes the
  `mainSessionId` lifecycle stamps.
- Cross-check protocol, mailbox reader, email-bus — deferred to other
  changes.
- Curator↔curator signaling — out of scope (only curator→main).

## Decisions

### D-H10 — Locked-decision deviation: prose-prompt vs custom `signal_main` tool

**Locked decision (verbatim):** "intercom will be in prose prompt … use
intercom."

**This design's choice: HONOR THE LOCKED DECISION.** The curator's prose
prompt instructs the curator LLM to use the stock `intercom({action:"send",
to:<main-name>, message})` tool, with the kind encoded as a text prefix in
the message body: `[STEER] <finding>` or `[APPEND] <finding>`. The
main-side receiver parses the prefix to recover the kind.

**Why honor (NOT invert):** The rejected Round 1 proposal inverted this to a
custom `signal_main` code tool and was flagged as verifier H10 / HIGH-1. The
prose-prompt approach satisfies the locked decision with ZERO new tool
surface on the curator side — the curator just uses stock intercom. The
prefix parsing on main is ~10 lines, less code than a custom tool.

**Alternative considered (and reserved as D-H10-FALLBACK if T0 forces it):**
If T0 reveals that the kind cannot round-trip through intercom's body text
either (e.g. body gets reformatted), then a deviation to a thin curator-side
`signal_main(kind, message)` tool wrapper around `intercom send` with
`customType: "curator_signal_<kind>"` is justified. If we take this fallback,
the design MUST add an explicit Decision Log entry "D-H10-DEVIATION" with
one-line rationale: "intercom body reformatting strips the kind prefix
(proven by T0); prefix-encoded customType is the minimum surface that
survives re-emit." This deviation is **CONDITIONAL on T0** — the default
is prose-prompt, no deviation.

### D-C3 — Non-interactive auto-reply interception (pick a/b/c)

When main is `pi -p` (RPC/non-interactive) AND busy, pi-intercom
`index.ts:670-687` returns the auto-reply string BEFORE calling
`pi.sendMessage`. NO extension hook fires. The rejected proposal asserted a
receiver could intercept this — verifier C3 called it "API FANTASY."

**This design's choice: (b) RPC-mode main → curator writes findings to
fallback file as PRIMARY path.** Specifically:
- When main detects it is in non-interactive mode (`ctx.mode === "rpc"`), the
  curator-receiver extension does NOT register the intercom listener at all.
  Instead, the curator's prose prompt is given a non-interactive branch:
  "if your main session is non-interactive, write the finding to
  `~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl` instead of
  using intercom." Main's `/curator status` (owned by lifecycle) reads and
  surfaces this file.
- In interactive mode, the normal intercom path runs.

**Why (b) over (a) or (c):**
- (a) patch pi-intercom for `skipAutoReplyFor` — requires modifying a runtime
  npm dep in `~/.pi/agent/npm/` (against the project's "NEVER patch
  node_modules directly" rule; would need a fork). Rejected.
- (c) main extension subscribes at broker level — bypasses pi-intercom tool
  layer but reimplements framing (`broker/framing.ts`), reconnect, and
  generation guards. Heavy. Rejected for v1.
- (b) needs no pi-intercom change, no broker client code, and the fallback
  file is also the broker-unreachable fallback (see D-FALLBACK-FILE) — single
  mechanism covers two failure modes.

**Trade-off:** RPC-mode main will not get live mid-run curator signals; it
gets them on the next `/curator status` poll. For RPC/CI workloads that is
acceptable — RPC main is not in a conversational loop anyway.

### D-C2/C4 — customType filtering and `details.kind` passthrough

**Problem:** pi-intercom re-emits with `customType: "intercom_message"`
(HARDCODED, `index.ts:586-593`). A receiver filtering
`customType === "curator_signal"` matches NOTHING (verifier C4). Research
also flags `details: entry` passthrough as UNVERIFIED (verifier C2).

**This design's choice — TWO-STAGE filter, T0-gated:**
1. **Receiver identifies curator messages by SENDER, not customType.**
   pi-intercom delivers `details.entry` containing the sender's session info;
   the receiver matches `details.sender.name` / `details.sender.sessionId`
   against the list of curators spawned for this main (provided by
   `add-curator-lifecycle`). This avoids the customType-hardcoding trap
   entirely.
2. **Kind recovery — T0 decides which of these works, in priority order:**
   - **(i)** Parse `[STEER]` / `[APPEND]` text prefix from `details.bodyText`
     (the intercom-rendered message body). This is the prose-prompt primary
     path and works regardless of customType/details structure.
   - **(ii)** If body reformatting strips the prefix (T0 disproves (i)),
     read `details.kind` field directly (research §4 says `details: entry` is
     passed verbatim — T0 confirms or denies).
   - **(iii)** If neither (i) nor (ii) survives, switch to D-H10-FALLBACK
     (custom `signal_main` tool with `customType: "curator_signal_steer"` /
     `"curator_signal_append"` — the customType suffix IS in the
     always-forwarded field and survives re-emit).

**Why three-stage:** Each stage degrades gracefully. (i) works with stock
intercom and the locked prose-prompt decision. (ii) is one field read if T0
confirms passthrough. (iii) is the deviation fallback only if both fail.

### D-KIND-MAP — `kind` → delivery semantics

| kind | Receiver action (in main process) | Wake idle? | Mid-turn behavior |
|------|-----------------------------------|-----------|-------------------|
| `steer` | `pi.sendMessage({customType:"curator_steer", content, display:true}, {triggerTurn:true, deliverAs:"steer"})` | ✅ Yes | Queued; delivered after current turn's tool calls |
| `append` | `pi.sendMessage({customType:"curator_append", content, display:<per persona config, default false>}, {deliverAs:"nextTurn"})` (NO `triggerTurn`) | ❌ No | Queued for next user prompt; does not interrupt |

**Why `nextTurn` for `append` (not `followUp`):** `followUp` against an
already-idle agent stalls forever (todo-enforcer `index.ts:200-212`).
`nextTurn` is the only true ambient mode — never triggers, never stalls, rides
the next user prompt. This is the documented "followUp-against-idle stall
trap" avoidance.

### D-DISPLAY — steer vs append visibility

- `steer`: `display:true` (user sees the intervention — it is forcing a turn).
- `append`: `display` per persona config, default `false` (pure ambient).
- **NOT asserted (verifier H9):** the claim that `display:false` hides a
  custom message from ACP/team delegated branches is UNVERIFIED. This design
  does NOT make "hidden from delegated branches" a hard REQ. If a delegated
  branch surfaces an `append` finding, that is acceptable for v1; hiding is
  a future probe (deferred).

### D-FALLBACK-FILE — broker-unreachable fallback (shared with D-C3)

When the intercom broker is unreachable:
1. The curator's intercom send fails (or the receiver never sees delivery).
   The curator retries ONCE (the broker auto-spawns on first connect per
   `broker/spawn.ts`).
2. On second failure, the curator writes the finding to
   `~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl` — same path
   as D-C3's non-interactive primary.
3. Main's `/curator status` (owned by lifecycle, cross-ref) reads and
   surfaces this file.

This unifies the non-interactive and broker-down fallbacks into one file
format.

### D-EXCEPTION — receiver safety

The receiver extension wraps ALL handling in try/catch. On exception:
- Log to UI only (`ui.notify` / `ui.setStatus`), `display:false` so it does
  not pollute the conversation.
- NEVER re-throw, NEVER block the main turn.
- A malformed curator signal is dropped (logged), not fatal.

### D-MAINID — session-targeting verification

The receiver verifies `details.mainSessionId === this-session-id` (or the
curator's known mainSessionId, supplied by `add-curator-lifecycle`) BEFORE
acting. A curator signal meant for a different main session is ignored
(curators are 1-per-main by default; "scope: all-sessions" is deferred).
This prevents a curator's signal leaking into the wrong main if the broker
ever broadcasts.

## Risks / Trade-offs

- **T0 may force path (b) as PRIMARY (not just RPC fallback).**
  → Mitigation: design is structured so the fallback-file path is fully
  specified and the intercom path is layered on top. If T0 shows intercom is
  unusable for ANY mode, the fallback-file becomes primary with zero
  redesign — just a config flip.
- **`append` findings may sit ambient for a long time** until the next user
  prompt surfaces them via `nextTurn`.
  → Mitigation: surfaced in proposal; curators reserve `append` for
  non-urgent observations. The persona prompt (owned by lifecycle) carries
  this guidance.
- **D-H10-FALLBACK (custom `signal_main` tool) is a locked-decision
  deviation.**
  → Mitigation: ONLY taken if T0 proves prose-prompt prefix parsing fails.
  When taken, an explicit `D-H10-DEVIATION` Decision Log entry is added with
  rationale. Never silent.
- **Sender-based filtering relies on lifecycle providing the curator session
  list** to the receiver.
  → Mitigation: cross-ref `add-curator-lifecycle` REQ that exposes
  `curatorsForMain(mainSessionId)`. If lifecycle is delayed, receiver falls
  back to "any sender whose name matches `curator*`" (loose match, logged).
- **H9 not resolved** — `display:false` may not hide from delegated branches.
  → Mitigation: not asserted as a hard REQ; documented as known limitation.
- **No proven "wake a dead main"** — if main crashed, no intercom delivery
  reaches it (research §3 Edge C).
  → Mitigation: broker drops the dead session from its registry; curator
  detects via `intercom({action:"list"})` and writes the fallback file. Main
  recovery (relaunch) is owned by lifecycle, not this change.

## Migration Plan

1. **T0 probe first** (tasks.md T0) — runs against live `pi-intercom` broker.
   Output gates every CONDITIONAL REQ. No code shipped before T0.
2. Implement receiver extension. Wire sender-list from lifecycle.
3. If T0 forces D-H10-FALLBACK: add curator-side `signal_main` tool + the
   deviation Decision Log entry.
4. If T0 forces path (b) as primary: enable fallback-file writer in curator
   prompt + reader in `/curator status`.
5. Smoke test: spawn a curator (via lifecycle), have it emit a `steer` and an
   `append`, verify main receiver delivers per the kind map.
6. Rollback: receiver extension is additive; disable the extension to revert.
   No data migration.

## Open Questions

- **T0-Q1**: Does pi-intercom forward full `details` (incl. `kind`)? Resolves
  D-C2/C4 stage (ii).
- **T0-Q2**: What `customType` does the receiver see? Resolves whether
  top-level filtering is viable (expected: NO).
- **T0-Q3**: Does non-interactive busy auto-reply fire before any hook?
  Resolves D-C3 (expected: YES → path (b) confirmed).
- **T0-Q4 (bonus)**: Does body text survive reformatting with `[STEER]` /
  `[APPEND]` prefix intact? Resolves D-C2/C4 stage (i) vs (iii).
- **Deferred (NOT this change)**: H9 probe (display:false vs delegated
  branches). Filed as a future probe if/when delegated-branch hiding
  becomes a real requirement.

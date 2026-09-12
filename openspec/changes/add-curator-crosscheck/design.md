## Context

`add-curator-lifecycle` (out-of-process curator sidecar, named personas,
new-forked-session-each-time) and `add-curator-signal` (`signal_main` over
pi-intercom) are the two foundational proposals. Neither has shipped artifacts
yet — this design names fields and paths that those proposals will need to honor,
and is explicitly marked early-stage so they can be revised once the foundations
land.

**Locked constraints (verbatim user decisions, immutable):**
- scope default = only spawning main; curators see peers on **same main only**
- failure must NOT block; cross-check degrades to independent signaling if the
  channel is down
- email-bus is WIP — do NOT depend on it; use **pi-intercom** or a **file mailbox**

**Hard engineering constraint from this team's design discipline:**
> Favor the SMALLEST working cross-check. Do NOT design a full voting / quorum /
> consensus system. The lean default is: shared JSONL findings file + each
> curator reads peers before signaling + first-finding-wins dedup.

The current pi-curator runtime directory convention (assumed from
`add-curator-lifecycle`): `~/.pi-curator/` houses per-main-session state. This
proposal adds one new subdirectory: `findings/<mainSessionId>/`.

## Goals / Non-Goals

**Goals:**
- Eliminate N-curator duplicate `signal_main` for the same finding.
- Stay strictly opt-in (default off; persona-driven).
- Fail-open with zero new hard dependencies — worst case == current behavior.
- Keep cross-check scoped to a single main session; no cross-main leakage.
- Keep the implementation tiny enough to fit in one curator-side hook on
  `signal_main` (read peers → dedup → maybe skip).

**Non-Goals** (re-stated for emphasis; verifiers should reject any of these
appearing in tasks.md):
- ❌ Quorum, majority vote, severity-weighted vote
- ❌ Conflict-resolution LLM (curators do not debate each other)
- ❌ Cross-session visibility (curators on main A cannot see main B's curators)
- ❌ A persistent aggregator daemon
- ❌ Acknowledgements / read-receipts / reply channel between curators
- ❌ Sub-line ordering or CRDT semantics

## Decisions

### D1 — Transport: **file mailbox** (JSONL), not pi-intercom, for v1.

**Choice:** `~/.pi-curator/findings/<mainSessionId>/shared.jsonl`, one JSON
object per line, append-only. Each curator `read` peers → maybe `signal_main` →
on signal, `append` its own finding.

**Alternatives considered:**

| Option | Verdict | Why |
|---|---|---|
| (a) Shared JSONL file mailbox | ✅ **Selected** | Zero new deps. Atomic append (POSIX `O_APPEND`). Trivially scoped by path key (`<mainSessionId>`). Garbage-collected with the session by the daemon from `add-curator-lifecycle`. Matches "email-bus is WIP, use file mailbox or pi-intercom". |
| (b) pi-intercom `curator:<alias>` → `curator:<alias>` direct messages | ❌ Rejected for v1 | Reuses a running broker, but adds fan-out complexity: every curator must subscribe to every peer; ordering across N peers is not guaranteed by the broker; and the broker auto-exits after 5s idle, so a 0-finding period drops it. Re-evaluate in a follow-up only if mailbox proves insufficient. |
| (c) Aggregation daemon | ❌ Rejected | Explicit non-goal. Adds a new long-running process, a new failure mode, and a new GC surface — all to solve a dedup that one read-modify-append per curator handles. |

**Why D1 holds even if pi-intercom looks tempting:** the dedup problem is
*read-before-write*. A single shared file is the simplest possible
read-before-write store. Direct messaging pushes the dedup state into each
curator's memory with no canonical source — strictly worse for first-finding-wins.

### D2 — Dedup rule: **first-finding-wins**, peers append agreement.

**Choice:** Before signaling, a curator reads the mailbox. If it finds a peer
finding with the **same `topic`** (an LLM-extracted short slug, e.g.
`"test-failing-ci"`) within a **dedup window** (default 10 min), it does **not**
call `signal_main`. Instead it appends an `agreement` entry:

```json
{"type":"agreement","topic":"test-failing-ci","curator":"quality","ts":"…","severity":"high"}
```

If no matching topic exists, it signals main normally and **then** appends a
`finding` entry:

```json
{"type":"finding","topic":"test-failing-ci","curator":"quality","ts":"…","severity":"high","summary":"…"}
```

**Alternatives considered:**

| Option | Verdict | Why |
|---|---|---|
| First-finding-wins + append agreement | ✅ **Selected** | Smallest viable. One read, one append, one optional skip. No counter, no clock sync. |
| Majority vote | ❌ | Forces curators to *wait* for peers. Violates "curator decides when to intercom" (locked). Adds liveness hazards (minority curator could block forever). |
| Severity-weighted | ❌ | Requires a global severity scale + ordering. Over-engineering for a dedup. |
| Last-finding-wins | ❌ | Encourages flip-flopping on the main. |

### D3 — Topic matching: **LLM-extracted slug at write time, exact string match at read time.**

**Choice:** The curator extracts a short `topic` slug from its own finding when
it appends. Peers do exact string equality on `topic`. No fuzzy match, no
embedding search, no canonicalization beyond case-insensitive trim.

**Rationale:** this is a *dedup*, not a semantic search. Two curators that both
call something `"failing-ci"` will dedup; two that disagree on the slug will
both signal — which is fine (and correctly preserves disagreement). Adding
fuzziness is gold-plating and a non-goal.

### D4 — Trigger: **before every `signal_main`**, configurable to critical-only.

**Choice:** Persona config `crossCheck.trigger ∈ {"before-every-signal" | "critical-only"}`.
Default `before-every-signal`. When `critical-only`, the cross-check read only
runs if the would-be signal is `severity === "critical"` (severity field from
`add-curator-signal`).

**Rationale:** `before-every-signal` maximizes dedup. `critical-only` is the
escape hatch for users who trust every critical to land even at the cost of
duplication. No third mode — keep it minimal.

### D5 — Failure handling: **silent fail-open, never block.**

**Choice:** Any error during read, parse, or append (file missing, parse error,
disk full, permission denied) is caught and logged at debug level only. The
curator then **proceeds to `signal_main` as if cross-check were disabled**. No
exception propagates to the curator's main loop. No retry. No backoff.

This satisfies the locked constraint:
> failure must NOT block; cross-check degrades to independent signaling if the
> channel is down

**Non-negotiable.** If any task in `tasks.md` adds retry/backoff/blocking to
cross-check, that is a verifier REJECT.

### D6 — Scope: **per-`<mainSessionId>` path, no enumeration API.**

**Choice:** Mailbox path = `~/.pi-curator/findings/<mainSessionId>/shared.jsonl`.
Curators only know their own main's id (passed at spawn by
`add-curator-lifecycle`). There is **no API to list other main sessions' mailboxes**.
Reinforces the locked "default = only the spawning main" scope.

### D7 — Lifecycle / GC: **mailbox dies with the session.**

**Choice:** The daemon from `add-curator-lifecycle` that GCs a main session's
curator state also `rm -rf`s `~/.pi-curator/findings/<mainSessionId>/`. No
retention, no archival, no cross-session history.

## Risks / Trade-offs

- **[Topic slug collision]** Two genuinely different findings get the same slug
  → second one is silently dropped as "agreement". → *Mitigation:* slug is
  curator-authored and short; severity + summary are still appended as
  agreement detail, so the second curator's *content* survives even if its
  signal doesn't. Acceptable for v1.

- **[Topic slug divergence]** Two same findings get different slugs → both
  signal, no dedup. → *Mitigation:* not a correctness bug — it's a missed
  optimization. Falls within "worst case == today's behavior". No fix needed.

- **[Stale agreement]** A peer's finding from 9 minutes ago still matches a new
  finding that is now stale (issue already resolved). → *Mitigation:* 10-min
  dedup window (configurable via `crossCheck.windowMinutes`, default 10) bounds
  the staleness; main-side dedup of identical signals is the safety net.

- **[File contention]** N curators appending concurrently → POSIX `O_APPEND` is
  atomic for writes under `PIPE_BUF` (4 KiB on Linux); findings are well under
  that. → *Mitigation:* confirmed; no locking needed for v1. If a finding ever
  exceeds 4 KiB (it won't — it's a slug + summary), revisit.

- **[Read-then-write race]** Curator A reads (empty) → Curator B reads (empty)
  → both signal → both append. Both signals land. → *Mitigation:* this is the
  **only** race, and its consequence is "duplicate signal for this one finding"
  — i.e., a missed dedup, not a correctness bug. Fully within "worst case ==
  today's behavior". Adding a lock would violate the "no new hard dependency,
  fail-open" principle. **Explicitly accepted.**

- **[Mailbox grows unbounded within a session]** A long main session could
  accumulate many findings. → *Mitigation:* file is per-session and GC'd with
  the session. No cap needed for v1; if it ever matters, truncate to last 1000
  lines on append.

- **[Early-stage drift]** `add-curator-lifecycle` and `add-curator-signal` may
  rename `mainSessionId`, the persona config shape, or the `signal_main` API.
  → *Mitigation:* all names in this design are placeholders; the proposal and
  tasks.md both flag this. Re-validate field names once the foundation proposals
  land.

## Migration Plan

No migration: this is a brand-new capability, opt-in by default. Deploying it
changes nothing for existing curators (`crossCheck.enabled` defaults to `false`).

**Rollback:** delete the cross-check read/append step from the curator's
`signal_main` hook. Mailbox files are inert; deleting the code is a complete
rollback. No data migration either direction.

**Sequence (assumes foundations ship first):**
1. Land `add-curator-lifecycle` (persona schema with `crossCheck` field stubbed
   optional, default disabled).
2. Land `add-curator-signal` (`signal_main` API).
3. Land this change: implement the read-append-skip hook, document the mailbox
   path convention in `add-curator-lifecycle`'s daemon GC list.

## Open Questions

1. **Persona config location.** Does `add-curator-lifecycle` keep persona
   config in `~/.pi-curator/personas/*.json` (local) and
   `~/.config/pi-curator/personas/*.json` (global)? This proposal assumes local;
   confirm when lifecycle lands.
2. **`mainSessionId` source.** Is it the forked session's `sessionId` or a
   stable alias assigned at spawn? Affects mailbox path stability across
   daemon restarts. Confirm with `add-curator-lifecycle`.
3. **Severity field on `signal_main`.** Does `add-curator-signal` actually
   expose a `severity` field, and what is its enum? Needed for
   `crossCheck.trigger === "critical-only"`. If absent, drop `critical-only`
   from this proposal's scope and ship `before-every-signal` only.
4. **Should agreement entries be visible to the main agent?** v1 says **no** —
   the mailbox is curator-only; the main sees only the first signal. If users
   later want "5 curators agreed" surfaced, that is a follow-up, not v1.

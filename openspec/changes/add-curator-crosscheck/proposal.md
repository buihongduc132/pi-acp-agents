## Why

When a main session runs **N curators in parallel** (per the locked architecture
decision: "EACH main session will have multiple curator"), independent curators
will rediscover and re-signal the *same* issue. The result is duplicate noise on
`signal_main`, wasted curator work, and ambiguity about whether the main agent is
seeing one finding N times or N distinct findings.

Cross-check gives curators a **read-only view of their peers' findings on the
same main session** before they signal, so the *first* finding is delivered once
and later curators append agreement instead of restating. It is explicitly an
**optimization**, never a hard dependency — if the cross-check channel is down,
curators fall back to fully independent signaling.

This proposal is **EARLY-STAGE**. It cross-references `add-curator-lifecycle`
and `add-curator-signal`, neither of which has shipped artifacts yet. The design
MAY need revision once those land (config schema names, file paths, persona
format). Treat the names below as placeholders aligned with the current
research, not frozen contracts.

> **Locked user decision (verbatim):**
> > "defer for now. Whenever creating the plan files, create the dedicated for
> > this defered onep."
>
> This IS that deferred plan file. Other locked constraints:
> - scope default = only spawning main; curators see peers on **same main only**
> - failure must NOT block; cross-check degrades to independent signaling if the
>   channel is down
> - email-bus is WIP — do NOT depend on it; use **pi-intercom** or a **file mailbox**

## What Changes

- **New capability `curator-crosscheck`** — opt-in peer visibility between
  curators on the **same** main session.
- A **shared findings mailbox**: a per-main-session JSONL file
  (`~/.pi-curator/findings/<mainSessionId>/shared.jsonl`) that each curator
  appends a finding to *before* signaling main, and reads *before* deciding
  whether to signal. Lean default; alternatives documented in `design.md`.
- A **first-finding-wins dedup rule**: when a curator reads the mailbox and finds
  a recent peer finding with the same topic, it appends an `agreement` entry
  instead of sending its own `signal_main`. Peers do **not** vote, do **not**
  quorum, do **not** run a conflict-resolution LLM.
- **Per-persona config** field `crossCheck` added to the curator persona schema
  defined by `add-curator-lifecycle`:
  - `crossCheck.enabled` (default `false` — opt-in)
  - `crossCheck.mode` ∈ `{"append-agreement" | "signal-anyway"}` (default
    `append-agreement`)
  - `crossCheck.trigger` ∈ `{"before-every-signal" | "critical-only"}`
    (default `before-every-signal`)
- **Hard failure-isolation requirement**: cross-check MUST NOT block `signal_main`
  and MUST NOT raise into the curator's main loop. Any read/write error degrades
  silently to independent signaling.
- **Scope enforcement**: curators see peers on the **same main session only**.
  The mailbox path is keyed by `<mainSessionId>`; there is no global list and no
  cross-main enumeration.

### Non-goals (explicit, to prevent gold-plating)

These are **out of scope** for this change and should NOT be implemented:

- ❌ Quorum / majority voting
- ❌ Severity-weighted voting
- ❌ Conflict-resolution LLM (curators do not debate each other)
- ❌ Cross-SESSION curator visibility (curators on main A cannot see main B's
  curators — deferred separately)
- ❌ An aggregation daemon / background service
- ❌ Read-receipts, acks, or a peer-to-peer reply channel
- ❌ Ordering guarantees beyond "append is atomic per line"

## Capabilities

### New Capabilities
- `curator-crosscheck`: peer visibility + first-finding-wins dedup between
  curators attached to the same main session. Default disabled, opt-in via
  persona config. Hard-fails-open to independent signaling on any error.

### Modified Capabilities
<!-- None. The base curator lifecycle and signal_main live in other proposals.
     This change introduces a brand-new capability; once add-curator-lifecycle
     lands, a follow-up delta MAY modify the persona-config spec to require the
     `crossCheck` field. For now, no existing capability requirements change. -->
- _(none — see note)_

## Impact

- **Depends on** `add-curator-lifecycle` (persona schema, spawn lifecycle, scope
  default = same main only) and `add-curator-signal` (`signal_main` API,
  pi-intercom transport). Cross-references both; assumes both exist by the time
  this ships.
- **New on-disk artifact**: `~/.pi-curator/findings/<mainSessionId>/shared.jsonl`
  (created lazily; per-session; auto-cleaned by the curator daemon GC from
  `add-curator-lifecycle`).
- **New persona-config field**: `crossCheck.{enabled, mode, trigger}`. Must be
  added to the persona schema in `add-curator-lifecycle` when that proposal is
  authored; this change documents the shape it expects.
- **No new IPC transport**: reuses the file mailbox (lean default). A
  pi-intercom `curator:<alias> → curator:<alias>` direct-message variant is
  documented as an alternative but not selected for v1 (keeps zero new broker
  dependencies and matches the "email-bus is WIP, do not depend" constraint).
- **No breaking changes** to curator lifecycle, signal_main, or pi-intercom.
- **Failure surface**: the only new failure mode is "mailbox unreadable"; the
  spec mandates this degrades to independent signaling, so worst-case behavior
  == today's behavior (no cross-check).

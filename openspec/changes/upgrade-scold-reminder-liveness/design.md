## Context

`scold-reminder` is an in-process pi extension (random / embedding-matched
accountability reminder injection via hook) located at
`pi-plugins/profile/extensions/scold-reminder/`. It fires on `message_end`
(assistant) every N turns and injects a reminder that holds the agent to its
configured instructions. Today its failure mode is **silent**: a thrown hook
(TEI unreachable, config invalid, JSON write race) is swallowed with no UI
signal and no restart path. The user cannot tell it is dead without inspecting
logs.

During the 2026-06-20 curator explore session the user locked two demands:

> "OH, scold-reminder degrades silence? ... Must have the status of the pi UI
> to shows it. Then have the slash cmd to restart it again for recover."
> "same as curator. it will not block, it must be able to self recover."

And: "remind me this afterward" — this proposal is the afterward.

The out-of-process curator (separate proposal `add-curator-lifecycle`) will
inherit this liveness pattern. This design establishes the **in-process** form
first so the pattern is proven cheap before being applied to the heavier
sidecar.

**Reuse source:** teams' `heartbeat-lease.ts` (`assessWorkerHeartbeatFreshness`,
atomic `.tmp.<pid>.<ts>` + `rename` write, `withLock` around RMW). Research at
`pi-plugins/flow/findings/curator-research-teams-staleness.md` confirms the
module is dependency-free and parameterized — copy the pattern, not the npm
dependency.

## Goals / Non-Goals

**Goals:**
- scold-reminder failure is **visible** in the pi UI (live/stale/dead/error).
- A slash command lets the user **recover** without restarting pi.
- Hardened failure mode: hook throws → `phase:"error"` written → UI flips.
- Self-recover warning on next session start.
- Establishes the liveness pattern the curator will inherit.

**Non-Goals:**
- Converting scold-reminder into an out-of-process curator (that is
  `add-curator-lifecycle`'s domain). scold-reminder stays in-process for cheap,
  deterministic nudges.
- Changing scold-reminder's reminder content, matching logic, or modes (only
  liveness / recoverability).
- A full health-monitoring subsystem / dashboard (gold-plating). Lean version:
  one heartbeat file + one UI status line + one slash command.
- Cross-check protocol, signal_main, email-bus (separate proposals).
- Persisting liveness state into conversation context (forbidden by AGENTS.md
  indicator-visibility rule).

## Decisions

### D1 — Heartbeat = single JSON file, written on every fire
**Choice:** `~/.pi-scold-reminder/heartbeat.json`, written atomically
(`.tmp.<pid>.<ts>` + `rename`) under `withLock(<file>.lock)` on every
fire/inject attempt.

**Why:** Mirrors teams' `~/.pi/agent/teams/<id>/config.json` member
`lastSeenAt` pattern verbatim. scold-reminder IS the main process — there is no
separate producer; the heartbeat is just the timestamp of its last fire. One
file, one read per turn, negligible I/O.

**Alternatives considered:**
- *PID file:* Teams research explicitly warns PID is diagnostic-only, not a
  liveness source. scold-reminder has no PID of its own (in-process). Rejected.
- *Push events via ui.bus:* overkill, and creates a second channel to maintain.
  Rejected.
- *No state, infer from log tail:* brittle, requires parsing. Rejected.

### D2 — Schema mirrors teams' member meta + curator recommendation
```jsonc
{
  "schemaVersion": 1,
  "lastFireAt":     "2026-06-20T10:05:12.345Z",  // written on every fire attempt
  "lastInjectedAt": "2026-06-20T10:05:12.345Z",  // written only when an injection actually happened
  "phase":          "live",                       // live | stale | dead | error | disabled
  "intervalMs":     180000,                       // expected fire interval (from config), for staleness math
  "turnsSinceFire": 3,
  "error":          null,                         // { message, code, errorAt } when phase=error
  "configVersion":  1,
  "host":           "bhd-laptop",
  "pid":            42185                         // diagnostic only — NOT a liveness source
}
```

**Why:** `phase` enum generalizes teams' `"idle"|"streaming"|"planning"|"shutdown"`
to the in-process reminder's lifecycle states. `intervalMs` carries the
configured expected fire cadence so staleness math is config-driven, not
hardcoded.

### D3 — Staleness classifier in the same extension's `turn_end` hook
**Choice:** On every `turn_end`, read the heartbeat file and classify:

| `lastFireAt` age vs `intervalMs` | `phase` written |
|---|---|
| age ≤ intervalMs × 2 | `live` |
| age ≤ intervalMs × 4 | `stale` |
| age > intervalMs × 4 | `dead` |

**Why:** Reuses `assessWorkerHeartbeatFreshness` timestamp-age math. Default
threshold `staleMs = 30_000` is teams' default — we generalize to
`intervalMs × N` because scold-reminder fires per-turn-interval, not on a 5s
wall-clock loop. Multipliers (2x stale / 4x dead) chosen to give the user a
visible "warning" band before "dead".

**Alternatives considered:**
- *Sibling extension hook:* adds a second extension + cross-extension state.
  Unnecessary — the same extension can read its own file. Rejected.
- *Periodic setInterval UI refresh:* teams does this (5s loop) but in-process
  we already run on every turn; a wall-clock loop is redundant. Rejected.

### D4 — UI indicator is UI-ONLY; never persists into context
**Choice:** `ctx.ui.setStatus("scold-reminder: stale")` on every classification
change; `ctx.ui.notify` on transitions to `error`/`dead`. NO
`ctx.sendMessage` / `sendUserMessage` for liveness state.

**Why:** AGENTS.md indicator-visibility rule — only safety-block / rule-violation
/ memory-tagging results persist into context. Liveness is operational, not
behavioral. Persisting it would pollute the agent's mental model and the
delegated (ACP/teams) branch.

**Alternatives considered:**
- *Inject a "scold-reminder is stale" system message:* violates the rule and
  would let the agent talk about its own liveness. Rejected.

### D5 — `/scold-restart` is NON-BLOCKING, idempotent
**Choice:** Slash command re-enables the extension (if disabled), clears
`phase` to `live`, re-reads config (re-embeds pool if needed), writes a fresh
`lastFireAt = now`. Returns immediately; the next fire uses the new state.

**Why:** User said "must be able to self recover" and "must not block". A
restart that blocks the agent defeats the purpose. Idempotent so re-running it
is safe.

**Alternatives considered:**
- *Full pi restart:* too heavy, user explicitly wanted a slash command.
- *Auto-restart on every `turn_end` when stale:* removes user agency and could
  hide a persistent failure (e.g. broken config). Rejected — surface to the
  user, let them decide.

### D6 — Hardened hook try/catch writes `phase:"error"`
**Choice:** Every existing hook entrypoint (`session_start`, `context`,
`message_end`, `session_shutdown`) is wrapped so that on throw it: (1) logs to
UI (`ctx.ui.notify`), (2) writes `{phase:"error", error:{message,code,errorAt}}`
to the heartbeat file. The classifier then surfaces `error` in the UI.

**Why:** Closes the "degrades to silence" hole. AGENTS.md exception-safety rule:
"Catch → log → return safe default." The error phase makes the failure
observable rather than invisible.

### D7 — Self-recover warning on `session_start`
**Choice:** On `session_start`, if the heartbeat file shows `phase:"error"` or
`lastFireAt` age > dead-threshold (carried over from a prior session),
`ctx.ui.notify("scold-reminder appears dead — run /scold-restart")`. Does NOT
auto-restart (user agency).

**Why:** A stale heartbeat survives across sessions (it's a file). Without a
start-up check, a dead scold-reminder from yesterday stays silent today.

### D8 — Governance split documented in proposal (not duplicated here)
The proposal records that code lands in `pi-plugins/` while this proposal is
tracked in `pi-acp-agents/`. No design implication beyond "tasks.md points at
the right repo".

## Risks / Trade-offs

- **[Risk] Heartbeat file write races across concurrent pi sessions.**
  → Mitigation: atomic write (`.tmp.<pid>.<ts>` + `rename`) + `withLock`.
  scold-reminder is per-session but the file is shared under `~/.pi-scold-reminder/`;
  last-writer-wins is acceptable because phase is monotone-ish (newest fire wins).

- **[Risk] Stale threshold `intervalMs × N` wrong for edge configs.**
  → Mitigation: multipliers are constants at top of module; documented as
  tunable. Tests cover boundary ages.

- **[Risk] UI `setStatus` spam on every turn.**
  → Mitigation: only emit on **phase transition**, not every classification.

- **[Risk] `/scold-restart` hides a persistent config bug.**
  → Mitigation: restart re-reads config; if config invalid, write
  `phase:"error"` with the parse error and surface it (do not pretend success).

- **[Risk] Gold-plating creep — adding a health dashboard.**
  → Mitigation: design discipline section in proposal explicitly bounds scope
  to heartbeat + status line + slash command. Verifier M16 lesson: avoid
  `severity` axis gold-plating.

- **[Trade-off] scold-reminder stays in-process (not converted).**
  → Accepted: cheap deterministic nudges win for the in-process case; the
  curator (out-of-process) inherits the pattern via `add-curator-lifecycle`.

## Migration Plan

1. Add heartbeat-writer module + staleness classifier to scold-reminder.
2. Wrap existing hooks with error→phase-write.
3. Register `/scold-restart` slash command.
4. Add `session_start` self-recover check.
5. Tests (heartbeat write, classifier thresholds, error-phase on throw,
   restart path, start-up warning).
6. Deploy via existing `pi-plugins` deploy chain. Rollback = revert extension
   dir; the heartbeat file is harmless if left behind (next fire overwrites it).

No data migration — heartbeat file is created on first fire.

## Open Questions

- **Q1:** Should `/scold-restart` be the canonical name or
  `/scold-reminder restart` (subcommand form)?
  **Default:** `/scold-restart` (shorter); register both as aliases.
  Defer final name to implementation.
- **Q2:** Should the heartbeat file path be configurable?
  **Default:** no — hardcode `~/.pi-scold-reminder/heartbeat.json` (parity with
  `~/.pi-curator/` layout the curator will use). Make configurable only if a
  real need arises.

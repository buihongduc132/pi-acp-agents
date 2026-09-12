## Context

This change delivers the **foundation** of a curator sidecar system for pi main
sessions. A "curator" is a short-lived, forked `pi` process that reviews the main
session as context and steers it. The signal channel (how a curator steers) is
out of scope here — `add-curator-signal` owns it. Without the lifecycle layer
(spawn, fork, track, GC, surface), none of the higher layers can be built.

### Constraints (locked user decisions — IMMUTABLE)

Every line below is from
`pi-plugins/flow/findings/curator/2026-06-20-locked-decisions-canonical.md`.
A design that violates any is an automatic reject.

- **Out-of-process**: a separate `pi`, with trimmed tools via opt-out.
- **Daemon = cleanup only, NOT spawning.** The main session spawns via hook.
- **"pi dead, child should be dead"** — child coupled to main lifecycle.
- **pm2 namespace** `pi-curator:<project>`.
- **New forked session each time** — no long-running curator that re-reads.
- **Push model** — main pushes context into the fork, curator does not pull.
- **Scope default = only the spawning main.** Each main session has MULTIPLE
  curators (not one for many).
- **Failure: must NOT block, self-recover.** New forked session handles this.
- **Identity**: named persona, local + global config, friendly alias (not jargon).
- **Non-bias CRITICAL** — strip `thinking` from fork.
- **Trim: 60% recent turns, 90% context ceiling, avoid overflow.**
- **Tool trim default: NOTHING** — omit `--exclude-tools`/`--tools` if config
  doesn't set it.
- **Curator is just a pi spawn** with `--append-system-prompt` to inject the
  requirement/goal.

### Verifier R1 failures this design MUST fix

(From `pi-plugins/flow/findings/curator/2026-06-20-explore-turn5-proposal-and-verifier-r1.md`)

| ID | Failure | Design fix in this doc |
|---|---|---|
| C1 | Forked curator inherits main `settings.json` → recursion fan-out | D1: spawn with `--no-extensions -e runtime -e intercom` |
| C5 | Exclusivity locks persona ~5min post-completion | D6: phase-aware exclusivity; `done`/dead = free |
| H6 | `<project>` in `pi-curator:<project>` undefined | D7: git toplevel basename |
| H7 | Spawn-gate state lost on janitor sweep | D2: `spawn-log/` survives sweep |
| H8 | Main↔curator concurrent edit race | D9: single-writer = main; curator edits advisory |
| M11 | HUMAN REMINDER buried in footnote | D13: visible tracker stub |
| M12 | Phase-transition underspecified | D8 + REQ-CR-09: `phase: done` is the LAST act in `beforeExit` |
| M13 | "100ms wall-time" fantasy | D10: fire-and-forget, non-blocking |
| M14 | stdio underspecified | D11: stderr→logs, stdout→/dev/null |
| M15 | single-oversized-turn trim rule not inlined | D5 + REQ-LC-04 inline it |
| M16 | `/curator restart` gold-plating | D12: dropped; `kill` + re-spawn suffices |

Note: C2/C3/C4/H9/H10 are about the **signal** path (intercom `details`
passthrough, `display:false`, customType) and are owned by `add-curator-signal`,
not this change. This change only guarantees the spawn command includes `-e
<pi-intercom>` so the signal change has somewhere to land.

### Composing

```text
┌─────────────────────────────── main session (pi) ───────────────────────────────┐
│  turn_end hook (pi-curator extension)                                            │
│    ├─ read curators.json (merged global+project)                                 │
│    ├─ for each enabled persona:                                                  │
│    │    ├─ read spawn-log entry → gate (turns/mins)                              │
│    │    ├─ read pids entry → phase-aware exclusivity                             │
│    │    ├─ assess staleness (heartbeat-lease.ts math) → ctx.ui.setStatus (UI)    │
│    │    └─ if gate passes AND slot free:                                         │
│    │         ├─ filter main JSONL → trimmed.jsonl (non-bias)                     │
│    │         ├─ write pids entry {phase: spawned}                                │
│    │         ├─ spawn pi --no-extensions -e runtime -e intercom --fork ...        │
│    │         └─ return fire-and-forget; hook yields                               │
│    └─ ensure janitor is running (pm2)                                            │
│                                                                                  │
│  every N turns:                                                                  │
│    ├─ /curator status → reads pids entries                                       │
│    └─ /curator kill <alias> → SIGTERM + mark phase: exiting                      │
└──────────────────────────────────────────────────────────────────────────────────┘
            │ child_process.spawn({detached:false})
            ▼
┌────────────────── curator child (pi --no-extensions) ───────────────────────────┐
│  loads only: pi-curator-runtime extension + pi-intercom                          │
│   (no settings.json inherited → no recursion)                                    │
│  runtime extension:                                                              │
│    ├─ write pids entry {phase: scanning, heartbeatAt: now}                       │
│    ├─ setInterval(refreshHeartbeat + phase) every 5s                             │
│    ├─ run task prompt (read main session as context)                             │
│    ├─ signal_main tool calls (degraded/no-op until add-curator-signal lands)     │
│    ├─ on completion: set phase: done                                             │
│    └─ process.on('beforeExit') → finalize phase: done → exit                     │
└──────────────────────────────────────────────────────────────────────────────────┘

┌─────────── pm2 janitor (pi-curator:<project>, GC only) ───────────┐
│  every 5min:                                                       │
│    ├─ for each pids entry:                                         │
│    │    ├─ if heartbeatAt age > deadSec OR pid dead: SIGTERM       │
│    │    └─ archive entry → ~/.pi-curator/archive/<ts>/             │
│    └─ GC trimmed.jsonl forks older than 24h                        │
│  NEVER spawns curators (spawn is main's job)                       │
└────────────────────────────────────────────────────────────────────┘
```

## Goals / Non-Goals

**Goals:**
- Spawn, fork, register, surface, and GC curator sidecars with zero main-thread
  blocking.
- Honor every locked user decision verbatim (see Constraints above).
- Provide a clean attachment point for `add-curator-signal` (the spawn command
  must include `-e <pi-intercom>`).
- Be exception-safe and degrade to a no-op when anything in the spawn path
  fails.

**Non-Goals:**
- **NOT** implementing the signal channel (`signal_main` tool, main-side
  receiver, intercom wiring) — `add-curator-signal`.
- **NOT** curator-to-curator cross-check — `add-curator-crosscheck`.
- **NOT** scold-reminder liveness upgrade — `upgrade-scold-reminder-liveness`.
- **NOT** mailbox — only if `add-curator-signal` proves intercom insufficient.
- **NOT** `includeThinking: true` bias analysis, `prctl(PDEATHSIG)` Linux
  hardening, `scope: "all-sessions"`, hot-reload of config.

## Decisions

### D1 — Anti-recursion: spawn with `--no-extensions -e <runtime> -e <intercom>`
**Choice**: `pi --no-extensions -e <pi-curator-runtime-path> -e <pi-intercom-path> --fork ...`
**Why**: verifier C1 — a forked curator that inherits the main's `settings.json`
would load the main-side `pi-curator` extension, fire its own `turn_end` hook,
and spawn a sub-curator → exponential fan-out. `--no-extensions` disables the
settings-driven extension load; the two `-e` flags explicitly re-add ONLY the
two extensions a curator is allowed to have.
**Alternatives considered**:
- (a) Curator-specific `settings.json` via `PI_CODING_AGENT_DIR` — heavier,
  requires a parallel config tree, leaks main's other extensions. Rejected.
- (b) `--exclude-tools` to remove spawn-related tools — does NOT stop the
  `turn_end` hook from firing. Rejected: the hook is the recursion vector.
**CONDITIONAL** on `pi --fork` composing correctly with `--no-extensions -e ...`
(unverified — listed as probe T0 in tasks). Fallback if the combination is
rejected by pi's flag parser: invoke the curator with
`PI_CODING_AGENT_DIR=<curator-only-minimal-dir>` where the minimal dir contains
ONLY `pi-curator-runtime` and `pi-intercom`. Either way the recursion guarantee
holds.

### D2 — Spawn-gate state survives the janitor sweep
**Choice**: `~/.pi-curator/spawn-log/<mainSessionId>/<curator>.json` with
`{lastSpawnAt, lastSpawnTurn}`. The gate reads THIS file, not the live `pids/`
file.
**Why**: verifier H7 — the `pids/` file is swept by the janitor every 5 min; if
the gate read from it, state would reset to "never spawned" after every sweep
and the gate would re-spam every turn. `spawn-log/` is NOT swept by the janitor
(it is GCed only at 24h by the artifact GC, not the live-state sweep).
**Alternatives**:
- (a) Embed spawn history in `pids/` — swept away. Rejected.
- (b) In-memory map — lost on main restart. Rejected.

### D3 — Non-bias filter: strip `thinking`, PRESERVE `compaction`
**Choice**: Filter drops only `thinking` blocks from assistant messages. ALL
other in-context entry types are kept: `message`, `custom_message`,
`branch_summary`, **`compaction`**.
**Why**: verifier C5 — compaction entries carry pre-compaction requirements.
Dropping them blinds the curator to anything that happened before the last
compaction, which kills the headline use case (the curator must review what the
main was *asked* to do, not just what it did after the last compaction).
`thinking` blocks are large and low-signal for review tasks (locked user
decision: "we do not need thinking").
**Alternatives**:
- (a) Drop compaction too — explicitly rejected (C5).
- (b) Configurable per persona (`includeThinking: true`) — kept as a
  **deferred** flag in config schema (`includeThinking`, default `false`) but
  the bias analysis for `true` is `curator-thinking-inclusion-policy`. v1 ships
  `false`-only.

### D4 — Trim: top-down, 60% recent target, 90% ceiling, atomic turns
**Choice** (inlined per verifier M15):
1. Compute `effectiveBudget = floor(curatorModel.contextWindow * 0.9) -
   reserveForOutput` (reserveForOutput default 8192).
2. Walk turns **newest-first**, accumulate `estimateTokens()` (chars/4, imported
   from `@earendil-works/pi-coding-agent`), prepend each turn to `kept` until
   adding the next would exceed `effectiveBudget`.
3. If `kept.length / turns.length < 0.6` AND there is headroom under
   `effectiveBudget`, continue walking older turns until 60% reached or budget
   exhausted.
4. **Single-oversized-turn rule**: if the newest turn ALONE exceeds
   `effectiveBudget`, trim WITHIN that turn: keep the user message + final
   assistant text, drop intermediate tool results oldest-first until it fits.
5. Never split a tool result from its tool call — turns are atomic units, and
   within a turn the call→result ordering is preserved.
**Why**: locked decisions ("60% recent, 90% ceiling, avoid overflow"). Matches
pi's own compaction cut-point rule (never break tool call↔result). No new deps
(no tiktoken).
**Alternatives**:
- (a) `--export` HTML + `markitdown` — lossy round-trip, loses tool pairing.
  Explicitly rejected by research (`curator-research-context-trim.md` §6–7).

### D5 — Lifecycle coupling: `child_process.spawn({detached:false})`
**Choice**: spawn the curator with `detached: false` (the default). The child is
in the main's process group and dies when the main dies.
**Why**: locked decision "pi dead, child should be dead". `detached:false` +
default signal propagation gives this for free on POSIX.
**Note on hardening**: `prctl(PR_SET_PDEATHSIG)` on Linux would make the child
suicide even if reparented. That is a deferred hardening
(`curator-prctl-pdeathsig`), NOT a v1 requirement. v1's guarantee is "main dies
normally → child dies"; the edge case "main is SIGKILLed and child is
reparented to init" is acceptable for v1 and explicitly out of scope.
**Alternatives**:
- (a) `nohm2`-managed curator that survives main — violates "pi dead, child
  should be dead". Rejected.
- (b) pm2 as curator parent — pm2 janitor is GC only (locked: "daemon = cleanup
  only, NOT spawn"). Rejected as a curator parent.

### D6 — Exclusivity is phase-aware, not time-aware
**Choice**: One curator per `(mainSession, persona)`. The spawn hook reads the
`pids/<mainSessionId>/<curator>.json`. Skip spawn ONLY if `phase` ∈
`{spawned, scanning, signaling, running}`. `phase: done` OR a dead/stale
heartbeat OR missing file ⇒ slot is FREE.
**Why**: verifier C5 — the R1 proposal locked the slot for ~5 min after
completion because it only checked "does a pids file exist". A completed
curator sitting in the pids file (until janitor sweep) blocked legitimate
re-spawns. Phase-awareness fixes this: `done` is terminal-and-free.
**Alternatives**:
- (a) Time-based "free after 5 min" — arbitrary, defeats the point.
- (b) Delete pids file on completion — loses the `done`/archive trail the
  janitor needs. Rejected.

### D7 — `<project>` in `pi-curator:<project>` = git toplevel basename
**Choice**: `<project>` = `basename(git rev-parse --show-toplevel)`. If not in a
git repo, fallback to `basename(cwd)`. Computed once at extension load, cached.
**Why**: verifier H6 — R1 left this undefined. Git toplevel basename is stable
across cwd changes within the same repo and uniquely identifies the project for
pm2 namespacing without requiring config.
**Alternatives**:
- (a) `package.json` name — not all dirs have one; drifts with publishes.
- (b) cwd basename — changes as the user `cd`s inside the repo. Rejected.

### D8 — Phase-transition protocol (curator runtime)
**Choice** (per verifier M12):
- `spawned` (written by main BEFORE `spawn()` returns) → `scanning` (curator
  runtime's first heartbeat) → `signaling` (curator invokes `signal_main`) →
  `done` (curator finished its analysis; sets this as its LAST act) → process
  exits.
- The `phase: done` write happens inside `process.on('beforeExit')` so it is
  guaranteed to run even on uncaught throws (the throw still propagates, but
  the phase marker lands first). On a hard crash (SIGKILL, OOM) the phase stays
  at whatever it last was, and the staleness detector reclassifies the slot as
  free via the dead-heartbeat path — so the slot is never permanently locked.
**Why**: locked decision "self-recover" — even a crashed curator must not hold
its slot forever. Two recovery paths (graceful via `beforeExit`, ungraceful via
dead-heartbeat) cover all cases.
**Alternatives**:
- (a) `phase: done` only on clean exit — crashes leak the slot. Rejected.

### D9 — Concurrency model: main is single-writer, curator edits are advisory
**Choice** (per verifier H8): By default the curator's task prompt says "you are
reviewing; do not modify files unless your persona explicitly declares it." A
persona that intends to mutate MUST declare `excludeTools: []` (i.e. opt INTO
mutating tools) AND the main-side hook treats all curator file writes as
**advisory** — the main is the single writer of record. Conflicts resolve in
main's favor.
**Why**: two pis editing the same repo simultaneously is a race the system
cannot lock away cheaply. Declaring "main wins" is honest and matches how a
human would treat a reviewer's edits.
**Alternatives**:
- (a) File-level locking between main and curator — heavy, deadlock-prone,
  pi has no such primitive. Rejected for v1.

### D10 — Non-blocking hook, fire-and-forget spawn
**Choice** (per verifier M13): The `turn_end` hook does its work and yields
WITHOUT awaiting the curator's completion. The filter is synchronous-and-fast
(JSONL read + in-memory trim, no LLM call); `child_process.spawn` is itself
non-blocking. All async work is `try/catch`'d and errors are surfaced UI-only
via `ctx.ui.setStatus`. The hook returns a safe default on any exception.
**Why**: pi startup is 45–55s; any "must complete in X ms" claim is fantasy.
The honest contract is "filtering + spawn must not block the main turn; spawn
is fire-and-forget".
**Alternatives**:
- (a) Await curator in the hook — blocks the main turn for minutes. Rejected.

### D11 — stdio: stderr → logs, stdout → /dev/null
**Choice** (per verifier M14): spawn with
`stdio: ['ignore', fs.openSync('/dev/null','w'), fs.openSync('<log>','a')]`.
The log path is `~/.pi-curator/logs/<mainSessionId>/<curator>-<ts>.stderr`.
The janitor GCs log files alongside the 24h fork artifact GC.
**Why**: curator stderr carries diagnostic noise (MCP init, deprecation
warnings) that is useless in the main turn but useful for post-mortem. stdout
is the LLM's response stream — the curator communicates findings via
`signal_main` (in `add-curator-signal`), NOT via stdout capture, so stdout is
discarded.
**Alternatives**:
- (a) Pipe stdout into main context — would pollute the main turn and re-introduce
  blocking. Rejected.
- (b) `inherit` stdio — curator's noise floods the main TUI. Rejected.

### D12 — Slash commands: `list | status | kill` only
**Choice** (per verifier M16): `/curator list`, `/curator status [<alias>]`,
`/curator kill <alias>`. NO `/curator restart` — restart is `kill` followed by
waiting for the next gate-eligible turn to re-spawn naturally.
**Why**: `restart` is gold-plating; the spawn gate already re-spawns on the
next eligible turn. A separate `restart` command duplicates that logic and
adds a config surface for nothing.
**Alternatives**:
- (a) Implement `/curator restart` — rejected as gold-plating.

### D13 — HUMAN REMINDER (scold-reminder) is in a visible tracker
**Choice** (per verifier M11): Create
`pi-plugins/flow/intentions/scold-reminder/liveness-tracker.md` (a one-line
stub) NOW, so the reminder "scold-reminder silence-degradation → separate change
`upgrade-scold-reminder-liveness`" is visible at the top level, not buried in a
tasks footnote. The actual liveness upgrade is out of scope here.
**Why**: R1 buried this in `tasks.md` DEF-3 footnote and the verifiers called
it out. A tracker file is the minimal, honest fix.

### D14 — Reuse `pi-agent-teams` `heartbeat-lease.ts` verbatim
**Choice**: Copy `assessWorkerHeartbeatFreshness()` and the atomic-write +
`withLock` patterns into `pi-curator`. Add `isPidAlive(pid)` (also from teams'
`doctor.ts`) as a **second signal** for faster dead-detection — teams doesn't
PID-check for liveness, but curator can safely (ESRCH ⇒ gone, EPERM ⇒ alive,
any other ⇒ assume alive). Defaults: live ≤30s, stale 30–120s, dead >120s OR
PID gone. Heartbeats are **on by default** (unlike teams which is opt-in).
**Why**: locked decision "reuse the heartbeat-lease pattern". Research
(`curator-research-teams-staleness.md` §5) confirms the module is parameter-
only, zero runtime deps on teams. The PID-as-second-signal addition is safe
because the timestamp is the primary signal — PID only ever flips
"stale→dead-faster".
**Alternatives**:
- (a) Build a bespoke staleness module — duplicated work, drifts from teams.
  Rejected.

## Risks / Trade-offs

- **[Risk] `pi --fork --no-extensions -e ... -e ...` flag combination unverified**
  → **Mitigation**: probe T0 in tasks runs the exact spawn command in a scratch
  dir before any code. Fallback (D1) is `PI_CODING_AGENT_DIR=<minimal>` which is
  flag-parser-safe. The design does not depend on the unverified combination.
- **[Risk] Main SIGKILLed → child reparented to init, leaks until janitor sweep**
  → **Mitigation**: janitor sweep is 5 min; the curator's own task has a
  bounded runtime (it processes a finite trimmed context and exits). Deferred
  hardening `curator-prctl-pdeathsig` closes the gap on Linux.
- **[Risk] Curator and main race on file edits** → **Mitigation**: D9 — main is
  single writer; curator edits are advisory. Personas that mutate must
  opt-in via `excludeTools: []` and accept "main wins on conflict".
- **[Risk] `signal_main` does not exist yet (delivered by a separate change)**
  → **Mitigation**: the default task prompt references `signal_main` but the
  curator degrades gracefully if the tool is absent — it logs inability to
  signal, sets `phase: done`, and exits. No crash, no slot leak.
- **[Risk] Trim drops the only turn that mentions a requirement** →
  **Mitigation**: D3 preserves compaction entries (which summarize pre-trim
  requirements); D4 keeps ≥60% of recent turns. The 40% dropped are the oldest
  and lowest-relevance by definition.
- **[Risk] Janitor and main race on the same `pids/` file** → **Mitigation**:
  atomic writes (`.tmp.<pid>.<ts>` + rename) and `withLock` around every RMW,
  matching teams' pattern exactly.
- **[Trade-off] No long-running curator state** — each spawn is a fresh fork
  with no memory of prior runs. This is a locked decision ("new forked session
  each time") and is the correct trade for self-recovery simplicity. A future
  change could add a curator memory file if review continuity is needed.
- **[Trade-off] `phase: done` is best-effort under hard crash** — a SIGKILLed
  curator stays at its last phase and relies on the dead-heartbeat path to free
  the slot (≤deadSec = 120s of stuck-slot worst case). Acceptable for v1.

## Migration Plan

1. **Land code** (no behavior change yet): ship `pi-curator` main-side extension
   + `pi-curator-runtime` curator-side extension. Hook is registered but does
   nothing if `~/.pi-curator/curators.json` is absent.
2. **Opt-in via config**: user creates `~/.pi-curator/curators.json` with one or
   more personas. First eligible turn spawns the first curator.
3. **Janitor bootstrap**: the main-side hook starts the pm2 janitor
   (`pi-curator:<project>`) on first spawn if it is not already running. No
   manual `pm2 start` required.
4. **Rollback**: delete `~/.pi-curator/curators.json` (or set `enabled: false`
   per persona). The hook becomes a no-op. Existing curator children finish
   their current run and exit; the janitor GCs their artifacts at 24h. To force
   immediate cleanup: `pm2 delete pi-curator:<project>` + `rm -rf ~/.pi-curator/`.

## Open Questions

- **OQ-1 (probe T0)**: does `pi --fork <X> --no-extensions -e A -e B
  --append-system-prompt C --name D --model E -p "F"` parse and run as expected?
  Resolved at task T0 before any curator code is written. Fallback in D1.
- **OQ-2 (probe T1)**: is `pi --fork` able to consume a JSONL file that has had
  `thinking` blocks stripped (i.e. does it tolerate modified assistant content)?
  If not, the filter must emit a session the loader accepts verbatim. Resolved
  at task T1.
- **OQ-3**: should the janitor be `pm2` or a plain `setInterval` daemon? Locked
  decision is "pm2 with dedicated namespace" — pm2 it is. No open question;
  listed here only to record that the locked decision was applied, not re-litigated.

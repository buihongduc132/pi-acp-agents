## Why

A pi main session has no automatic second pair of eyes. Curators — short-lived
forked `pi` sidecars — are spawned on a configurable cadence to review the main
session and steer it (signal channel is a separate change: `add-curator-signal`).
Today there is no foundation that spawns them, tracks them, or reclaims them;
without that lifecycle layer, every curator idea is unbuildable. This change
delivers the **foundation only**: spawn, fork-with-non-bias-filter, lifecycle
coupling (child dies with main), heartbeat staleness, GC janitor, and slash
commands — all of which are user-locked decisions that must exist before any
signal or cross-check work can land.

## What Changes

- **NEW main-side extension `pi-curator`** that, on `turn_end`, optionally spawns
  one or more curator children per configured persona. Main owns spawning; the
  janitor daemon NEVER spawns.
- **NEW spawn gate** per persona: skip spawn until `turn >= everyTurns` OR
  `minutes since last spawn >= everyMins`. Gate state lives in
  `~/.pi-curator/spawn-log/<mainSessionId>/<curator>.json` so it survives the
  janitor sweep (verifier H7 fix).
- **NEW non-bias context filter**: filters the main session JSONL into a trimmed
  fork input. Drops `thinking` blocks (large, low-signal). **PRESERVES
  `compaction` entries** — they carry pre-compaction requirements and dropping
  them blinds the curator (verifier C5 fix). Trims from the top, keeps the most
  recent 60% of turns as target, hard ceiling 90% of curator context budget,
  never cuts a tool result away from its tool call.
- **NEW child spawn primitive**: `child_process.spawn({detached:false})` so the
  child dies with the main process ("pi dead, child should be dead"). The spawn
  command is `pi --no-extensions -e <pi-curator-runtime> -e <pi-intercom>
  --fork <filtered.jsonl> --append-system-prompt <goalFile> --name "curator:<alias>"
  --model <model> -p "<taskPrompt>"` — the `--no-extensions -e ... -e ...`
  combination prevents the forked curator from inheriting main's `settings.json`
  and re-spawning sub-curators on its own `turn_end` (verifier C1 recursion fix).
- **NEW PID + heartbeat registration** at `~/.pi-curator/pids/<mainSessionId>/<curator>.json`
  with `{pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt,
  phase, goalFile}`. Curator child refreshes `heartbeatAt` every 5s and updates
  `phase` (`scanning` | `signaling` | `done` | `exiting`).
- **NEW staleness detection** at `turn_end`, reusing `pi-agent-teams`'
  `heartbeat-lease.ts` staleness math verbatim: live ≤30s, stale 30–120s, dead
  >120s or PID gone. **UI-only** via `ctx.ui.setStatus` — never injected into
  conversation context (delegated ACP/teams branches see nothing).
- **NEW exclusivity rule** (verifier C5 fix): one curator per `(mainSession,
  persona)`. Skip spawn ONLY if `phase` is `spawned | running | signaling`. A
  `done` or dead curator frees the slot immediately — no 5-minute lockout.
- **NEW PM2 janitor** — **GC only, NEVER spawns**. Namespace
  `pi-curator:<project>` where `<project>` is the **git toplevel basename**
  (verifier H6 fix — DEFINED here). Ticks every 5 minutes: SIGTERMs dead PIDs +
  archives their registration, GCs fork artifacts older than 24h. Stateless.
- **NEW slash commands** `/curator list|status|kill` (no `/curator restart` —
  gold-plating per verifier M16; restart is `kill` + letting the next turn
  re-spawn naturally).
- **NEW config schema** with global + project persona layering:
  `~/.pi-curator/curators.json` deep-merges with project
  `.pi-curator/curators.json`, alias-keyed, friendly names. Defaults:
  `scope: "main-only"`, `includeThinking: false`, `appendDisplay: false`,
  `heartbeat.{intervalSec:5, staleSec:30, deadSec:120}`. Tool trim defaults to
  **NONE** (omit `--exclude-tools`/`--tools` entirely unless persona sets it —
  locked user decision).
- **NEW default task prompt template** that tells the curator it is a sidecar of
  session `<name & id>`, points at the goalFile, scopes it to main-only, and
  tells it to use the `signal_main` tool (delivered by `add-curator-signal`).
- **Non-blocking + exception-safe hook**: the `turn_end` hook catches all errors,
  logs them UI-only, and returns a safe default. Filtering + spawn must NOT
  block the main turn; spawn is fire-and-forget (verifier M13 fix — no "100ms
  wall-time" fantasy, `pi` startup is 45–55s).

### Out of scope (cross-referenced as separate changes, NOT bundled)

| Concern | Future change |
|---|---|
| `signal_main` tool + main-side receiver + intercom wiring | `add-curator-signal` |
| Curator-to-curator cross-check protocol | `add-curator-crosscheck` |
| scold-reminder silence-degradation liveness upgrade | `upgrade-scold-reminder-liveness` |
| File-based mailbox (only if intercom proves insufficient) | `add-curator-mailbox` |
| `includeThinking: true` bias analysis | `curator-thinking-inclusion-policy` |
| `prctl(PR_SET_PDEATHSIG)` Linux coupling hardening | `curator-prctl-pdeathsig` |
| `scope: "all-sessions"` cross-session curators | `curator-cross-session-scope` |
| Hot-reload of config | `curator-config-hotreload` |

## Capabilities

### New Capabilities
- `curator-lifecycle`: Spawn gate, non-bias context filter, child spawn
  primitive (anti-recursion), PID + heartbeat registration, staleness detection,
  exclusivity, PM2 janitor (GC only), slash commands, exception-safe hook.
- `curator-config`: Persona-layered config schema (global + project deep-merge,
  alias-keyed, friendly names) with all defaults; tool-trim-default = none.
- `curator-runtime`: The forked curator's heartbeat refresh loop, phase
  transitions, and `beforeExit` phase:done protocol (the runtime extension the
  main-side spawns via `-e <path>`).

### Modified Capabilities
<!-- None — all three capabilities above are new. -->

## Impact

- **New code** (this repo, `pi-acp-agents`):
  - `src/extensions/pi-curator/` — main-side extension (spawn, gate, filter,
    registry, slash command, staleness UI).
  - `src/extensions/pi-curator-runtime/` — curator-side runtime (heartbeat
    loop, phase transitions, `beforeExit` marker).
- **New runtime files** under `~/.pi-curator/`: `pids/<mainSessionId>/`,
  `spawn-log/<mainSessionId>/`, `logs/`, `curators.json`, `archive/`.
- **PM2 process**: stateless janitor process under namespace
  `pi-curator:<project>` (one per git project). Started by the main-side hook
  on first spawn if not already running; never spawns curators.
- **Dependencies**: reuses `pi-agent-teams`' `heartbeat-lease.ts` staleness math
  (copied, not depended on at runtime) and `@earendil-works/pi-coding-agent`'s
  exported `estimateTokens()` for the trim budget (chars/4, matches pi's own
  accounting). No new npm runtime dependencies.
- **External coupling**: NONE in this change. The `signal_main` tool referenced
  in the default task prompt is provided by `add-curator-signal`; until that
  lands, the curator's task prompt degrades gracefully (curator logs inability
  to signal, completes analysis, sets `phase: done`, exits).
- **No breaking changes** to existing pi-acp-agents behavior. All new
  functionality is opt-in via config (`~/.pi-curator/curators.json` absent ⇒ no
  spawn, no-op hook).

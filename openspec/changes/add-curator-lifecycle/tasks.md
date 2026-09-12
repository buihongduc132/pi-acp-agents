# Tasks — add-curator-lifecycle

> **Cross-references to separate changes** (do NOT bundle these into this change):
> - `add-curator-signal` — the `signal_main` tool, main-side receiver, intercom wiring.
> - `add-curator-crosscheck` — curator-to-curator cross-check protocol.
> - `upgrade-scold-reminder-liveness` — scold-reminder silence-degradation fix (see HUMAN REMINDER tracker at `pi-plugins/flow/intentions/scold-reminder/liveness-tracker.md`).
> - `add-curator-mailbox` — only if `add-curator-signal` proves intercom insufficient.
> - `curator-thinking-inclusion-policy` — `includeThinking: true` bias analysis.
> - `curator-prctl-pdeathsig` — Linux `prctl(PR_SET_PDEATHSIG)` hardening.
> - `curator-cross-session-scope` — `scope: "all-sessions"` cross-session curators.
> - `curator-config-hotreload` — hot-reload of config.

## 1. Probes (BLOCKING — resolve before code)

- [ ] 1.1 **T0 — spawn flag combination probe**: run `pi --no-extensions -e <test-runtime> -e <test-intercom> --fork <scratch.jsonl> --append-system-prompt <scratch.md> --name "curator:probe" --model <model> -p "say hi"` in a scratch dir; verify the process starts, loads ONLY the two `-e` extensions, and does NOT load anything from settings.json. Record output. If flag combination is rejected, switch to fallback `PI_CODING_AGENT_DIR=<minimal-dir>` per design D1.
- [ ] 1.2 **T1 — stripped-thinking JSONL probe**: produce a JSONL with one assistant message that had `thinking` blocks stripped; run `pi --fork <stripped.jsonl>`; verify the loader accepts the modified file without errors. If rejected, the filter must emit a loader-compatible session.
- [ ] 1.3 **T2 — `estimateTokens` import probe**: verify `import { estimateTokens } from "@earendil-works/pi-coding-agent"` resolves and returns a number for a sample message. If not exported, fall back to a local chars/4 implementation.
- [ ] 1.4 **T3 — git toplevel basename probe**: run `git rev-parse --show-toplevel` from inside the main session cwd; verify the basename is the intended `<project>` value. Verify fallback to `basename(cwd)` when not in a git repo.

## 2. Scaffolding

- [ ] 2.1 Create `src/extensions/pi-curator/` (main-side extension) and `src/extensions/pi-curator-runtime/` (curator-side runtime). Add minimal `package.json`/`tsconfig.json`/index entry so both compile.
- [ ] 2.2 Copy `pi-agent-teams`' `heartbeat-lease.ts` staleness math (`assessWorkerHeartbeatFreshness`, `isPidAlive` from `doctor.ts`) into a shared `src/lib/curator-staleness.ts`. Add tests covering live/stale/dead branches.
- [ ] 2.3 Copy the atomic-write + `withLock` utilities from `pi-agent-teams`' `team-config.ts` / `fs-lock.ts` into a shared `src/lib/curator-fs.ts`. Add tests for concurrent-write safety.
- [ ] 2.4 Create the scold-reminder HUMAN REMINDER tracker stub at `pi-plugins/flow/intentions/scold-reminder/liveness-tracker.md` (verifier M11 fix) — a one-line note pointing to `upgrade-scold-reminder-liveness`.

## 3. Config layer (`curator-config` capability)

- [ ] 3.1 Implement the config loader: read global `~/.pi-curator/curators.json`, deep-merge with project `.pi-curator/curators.json`. Reject on `excludeTools` + `tools` both set, or missing `alias`/`goalFile`.
- [ ] 3.2 Implement the default task prompt template generator (REQ-CF-04 equivalent): prose prompt with main session name+id, goalFile pointer, main-only scope, `signal_main` reference, "do not modify unless persona allows", "exit when done".
- [ ] 3.3 Implement tool-trim flag assembly: omit `--exclude-tools`/`--tools` unless config sets one (locked decision). Add `excludeTools`→`--exclude-tools csv`, `tools`→`--tools csv`.
- [ ] 3.4 Implement config error handling: malformed persona → log UI-only via `ctx.ui.setStatus`, skip persona, do NOT crash or block.

## 4. Non-bias filter (`curator-lifecycle` — filter)

- [ ] 4.1 Implement the JSONL reader: parse main session JSONL, walk parentId chain from leaf to root to compute the active branch set, drop off-branch entries.
- [ ] 4.2 Implement entry-type filter: keep `message`, `custom_message`, `branch_summary`, `compaction`; drop `session_info`, `model_change`, `thinking_level_change`, `label`. **PRESERVE compaction** (verifier C5).
- [ ] 4.3 Implement `thinking`-block stripping: for each assistant message, filter out `block.type === "thinking"` content blocks; preserve all other content.
- [ ] 4.4 Implement the trim algorithm: chars/4 token estimate via `estimateTokens`, newest-first greedy accumulate within `effectiveBudget = floor(contextWindow*0.9) - 8192`, soft 60% target, never split a tool result from its tool call, single-oversized-turn rule (keep user + final assistant text, drop intermediate tool results oldest-first).
- [ ] 4.5 Write the filtered output to `~/.pi-curator/forks/<mainSessionId>/<curator>-<ts>.jsonl` (atomic write: tmp + rename).
- [ ] 4.6 Add filter tests: thinking stripped, compaction preserved, off-branch dropped, 90% ceiling respected, single oversized turn trimmed within, tool/result never split.

## 5. Main-side spawn (`curator-lifecycle` — spawn, gate, exclusivity)

- [ ] 5.1 Implement the spawn-gate: read `~/.pi-curator/spawn-log/<mainSessionId>/<curator>.json`; allow spawn if `turn >= everyTurns` OR `mins >= everyMins`; update on spawn. Gate MUST survive janitor sweep (janitor never GCs `spawn-log/`; only the 24h artifact GC touches it).
- [ ] 5.2 Implement phase-aware exclusivity: read `~/.pi-curator/pids/<mainSessionId>/<curator>.json`; skip spawn ONLY if `phase ∈ {spawned, scanning, signaling, running}`; `done`/dead/missing ⇒ free (verifier C5 fix).
- [ ] 5.3 Implement the spawn command builder: produce `pi --no-extensions -e <pi-curator-runtime> -e <pi-intercom> --fork <filtered.jsonl> --append-system-prompt <goalFile> --name "curator:<alias>" --model <model> -p "<taskPrompt>"`. Add `--exclude-tools`/`--tools` only if config sets them. **CRITICAL**: `--no-extensions` is mandatory (verifier C1 fix).
- [ ] 5.4 Implement PID file write BEFORE `child_process.spawn`: `{pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt: spawnedAt, phase: "spawned", goalFile}` (atomic write + withLock).
- [ ] 5.5 Implement the actual `child_process.spawn({detached: false})` with stdio config: `stdin` ignore, `stdout` → `/dev/null`, `stderr` → append to `~/.pi-curator/logs/<mainSessionId>/<curator>-<ts>.stderr` (verifier M14 fix).
- [ ] 5.6 Wire the `turn_end` hook: for each enabled persona, evaluate gate → exclusivity → filter → spawn. Wrap ALL work in try/catch; on error, log UI-only via `ctx.ui.setStatus` and return safe default. Hook MUST NOT await child completion (verifier M13 fix).
- [ ] 5.7 Add tests: gate passes/blocks, exclusivity blocks on active phase but frees on done/dead, spawn command contains `--no-extensions`, PID file written before spawn, hook does not throw on filter/spawn errors.

## 6. Curator runtime (`curator-runtime` capability)

- [ ] 6.1 Implement `pi-curator-runtime` extension init: read PID file path from env/args, write first heartbeat with `phase: "scanning"`, start `setInterval` heartbeat loop (`heartbeat.intervalSec` default 5).
- [ ] 6.2 Implement the heartbeat refresh: atomic write `{heartbeatAt: <now>, phase: <current>, pid}`; `heartbeatInFlight` guard to skip overlapping ticks; swallow write failures and retry (matches teams `publishHeartbeat`).
- [ ] 6.3 Implement phase transitions: `scanning` → `signaling` (when `signal_main` is invoked) → `done` (final). Set `phase: "done"` inside `process.on('beforeExit')` handler.
- [ ] 6.4 Make the `beforeExit` handler non-throwing (try/catch around the atomic write; swallow and exit).
- [ ] 6.5 Implement graceful degradation: detect whether `signal_main` tool is registered; if absent, log to stderr, run analysis read-only, set `phase: "done"`, exit.
- [ ] 6.6 Implement defensive check: verify the main-side `pi-curator` extension is NOT loaded alongside the runtime; log warning via stderr if it is (misconfiguration signal).
- [ ] 6.7 Add tests: heartbeat writes every interval, heartbeat write failure is swallowed, phase transitions land in order, `beforeExit` sets done on clean + throw paths, curator exits cleanly without `signal_main`.

## 7. Staleness detection (UI-only)

- [ ] 7.1 Implement `assessCurator(state, nowMs)` using the copied `assessWorkerHeartbeatFreshness` math + `isPidAlive` second signal. Classifications: live ≤30s, stale 30–120s, dead >120s OR pid gone. Use per-persona `heartbeat.{staleSec, deadSec}` overrides.
- [ ] 7.2 Wire staleness into the `turn_end` hook (after spawn evaluation): update `ctx.ui.setStatus` with the classification per curator. Staleness output MUST be UI-only — MUST NOT enter conversation context.
- [ ] 7.3 Add tests: live/stale/dead branches, ESRCH → dead, EPERM → alive, classification overrides via config.

## 8. PM2 janitor (GC only, never spawns)

- [ ] 8.1 Implement the janitor entry point: standalone script under `src/bin/curator-janitor.ts` that runs a `setInterval` every 5 minutes.
- [ ] 8.2 Compute `<project>` = `basename(git rev-parse --show-toplevel)` (fallback `basename(cwd)`) (verifier H6 fix). Cache at startup.
- [ ] 8.3 Implement dead-curator sweep: for each `pids/` entry, if `heartbeatAt` age > `deadSec` OR `isPidAlive(pid) === false`, SIGTERM the PID and archive the entry to `~/.pi-curator/archive/<timestamp>/`.
- [ ] 8.4 Implement artifact GC: delete trimmed JSONL files and stderr log files older than 24h.
- [ ] 8.5 Confirm the janitor NEVER spawns curators (no `child_process.spawn` of `pi --fork ...`). Re-spawn is exclusively the main-side hook's responsibility.
- [ ] 8.6 Implement janitor bootstrap: the main-side hook starts the pm2 janitor process (namespace `pi-curator:<project>`) on first spawn if it is not already running.
- [ ] 8.7 Add tests: dead PID gets SIGTERM'd + archived, old artifact gets deleted, janitor does not spawn, namespace is project-scoped, fallback for non-git.

## 9. Slash commands (`/curator list | status | kill`)

- [ ] 9.1 Implement `/curator list`: enumerate all `pids/<mainSessionId>/*.json` across all main session dirs; display alias, phase, heartbeat age.
- [ ] 9.2 Implement `/curator status [<alias>]`: show full `pids/` file + staleness classification for one or all curators.
- [ ] 9.3 Implement `/curator kill <alias>`: SIGTERM the PID, atomically update `phase: "exiting"`.
- [ ] 9.4 Confirm `/curator restart` is NOT registered (verifier M16 fix). If invoked, report "not available, use kill + wait for next gate-eligible turn".
- [ ] 9.5 Add tests: list shows all curators, status shows detail, kill sends SIGTERM + sets phase, restart reports unavailable.

## 10. Integration & verification

- [ ] 10.1 End-to-end happy path: write a 1-persona `curators.json`, run a fake main session through N turns, verify a curator was spawned with the right command, heartbeats refreshed, and `phase: done` landed on exit.
- [ ] 10.2 Anti-recursion verification: spawn a curator and verify NO sub-curator was spawned by the curator's own `turn_end` (the `--no-extensions` guarantee).
- [ ] 10.3 Filter verification: feed a main session with `thinking` blocks and a `compaction` entry; verify the fork JSONL has no thinking blocks and the compaction entry is preserved.
- [ ] 10.4 Non-blocking verification: instrument the `turn_end` hook and confirm it returns synchronously without awaiting the curator child.
- [ ] 10.5 Exception safety verification: trigger spawn errors (missing `pi` binary) and filter errors (corrupt JSONL); confirm main session is unaffected and the error surfaces UI-only.
- [ ] 10.6 Run `openspec validate add-curator-lifecycle --strict` and resolve any reported issues.
- [ ] 10.7 Update AGENTS.md extension inventory to include `pi-curator` and `pi-curator-runtime`.

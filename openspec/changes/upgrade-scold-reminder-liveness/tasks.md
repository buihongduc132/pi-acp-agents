# Tasks — upgrade-scold-reminder-liveness

> **Governance note:** This proposal is tracked in `pi-acp-agents/openspec/`,
> but ALL code work lands in `pi-plugins/profile/extensions/scold-reminder/`.
> No edits to `pi-acp-agents/src/`. Deploy via the existing `pi-plugins` deploy
> chain (`mise run deploy-*`), not the pi-acp-agents pipeline.

## 1. Heartbeat writer (reuse teams pattern)

- [ ] 1.1 Create `heartbeat.ts` in `pi-plugins/profile/extensions/scold-reminder/` exporting `writeHeartbeat(record)` using atomic write (`.tmp.<pid>.<ts>` + `rename`) under `withLock(heartbeat.json.lock)`. Mirror teams' `team-config.ts` `writeJsonAtomic` + `fs-lock.ts`.
- [ ] 1.2 Define `HeartbeatRecord` type with fields: `schemaVersion`, `lastFireAt`, `lastInjectedAt`, `phase` (`live|stale|dead|error|disabled`), `intervalMs`, `turnsSinceFire`, `error`, `configVersion`, `host`, `pid`.
- [ ] 1.3 Hardcode path `~/.pi-scold-reminder/heartbeat.json`; create parent dir on first write.
- [ ] 1.4 Wire `writeHeartbeat` into the existing fire path in `index.ts` so every fire attempt (inject OR skip) writes `lastFireAt = now`; set `lastInjectedAt` only when an injection actually happened.

## 2. Staleness classifier (reuse teams math)

- [ ] 2.1 Create `staleness.ts` exporting `classifyPhase(heartbeat, nowMs)` returning `{ phase, reason }`. Reuse `assessWorkerHeartbeatFreshness` timestamp-age math.
- [ ] 2.2 Define module constants `STALE_MULTIPLIER = 2`, `DEAD_MULTIPLIER = 4`; classify by `lastFireAt` age vs `intervalMs × N`. Missing/unparseable file → `{ phase: "stale", reason: "missing"|"invalid" }`, never throws.
- [ ] 2.3 Add a `turn_end` hook that reads the heartbeat file, runs `classifyPhase`, and tracks the last-reported phase (in-memory) for transition-only emission.

## 3. Hardened hook try/catch → error phase

- [ ] 3.1 Wrap every existing hook (`session_start`, `context`, `message_end`, `session_shutdown`) so that on throw it: catches, calls `ctx.ui.notify` with the error, writes `{ phase: "error", error: { message, code, errorAt } }` to the heartbeat file, returns safe default. Per AGENTS.md exception-safety rule.
- [ ] 3.2 Confirm no hook can propagate an exception to the pi caller; add a regression test that forces each hook to throw and asserts the turn completes normally.

## 4. UI indicator (UI-only, transitions-only)

- [ ] 4.1 On phase transition (different from last-reported phase), call `ctx.ui.setStatus("scold-reminder: <phase>")`. On transitions into `error` or `dead`, also call `ctx.ui.notify` with a short message.
- [ ] 4.2 Verify NO `ctx.sendMessage` / `sendUserMessage` is used for liveness state (AGENTS.md indicator-visibility rule). Confirm nothing persists into conversation context or branches seen by ACP/teams.

## 5. Self-recover warning on session_start

- [ ] 5.1 In the `session_start` hook (after config load), read the heartbeat file. If `phase === "error"` OR `lastFireAt` age > dead threshold, `ctx.ui.notify("scold-reminder appears dead — run /scold-restart")`.
- [ ] 5.2 Do NOT auto-restart. Make the check fire-and-forget; on read failure silently no-op. Never block session start.

## 6. /scold-restart slash command

- [ ] 6.1 Register `/scold-restart` slash command (alias `/scold-reminder restart`). Handler: re-enable extension if disabled, re-read config (re-embed pool if embedding mode), clear stale/error phase, write `phase: "live"` + `lastFireAt = now`. Return immediately (non-blocking).
- [ ] 6.2 If config re-read fails, write `phase: "error"` with descriptive `error.message` and report via `ctx.ui.notify` (do NOT fake success). Idempotent: re-running on `live` is a no-op success.
- [ ] 6.3 Response is UI-only (`ctx.ui.notify`); no message injected into conversation context.

## 7. Tests

- [ ] 7.1 Unit: `writeHeartbeat` produces valid atomic file; survives two concurrent `writeHeartbeat` calls without corruption.
- [ ] 7.2 Unit: `classifyPhase` boundary ages (just-under-stale, just-over-stale, just-under-dead, over-dead, missing file, unparseable file) → correct phase.
- [ ] 7.3 Integration: forced hook throw → heartbeat `phase: "error"`, UI notified, turn completes normally.
- [ ] 7.4 Integration: `/scold-restart` from stale/dead/error → `phase: "live"`; idempotent on `live`; broken config → `phase: "error"` (no fake success).
- [ ] 7.5 Integration: `session_start` with stale/error heartbeat → notify fires; with fresh/missing heartbeat → silent.
- [ ] 7.6 Regression: confirm no liveness state appears in conversation context / delegated-agent branch.

## 8. Docs + deploy

- [ ] 8.1 Update `pi-plugins/AGENTS.md` Extensions table if scold-reminder's responsibilities change (they should not — only liveness added). Add a one-line note that scold-reminder now exposes liveness via heartbeat + `/scold-restart`.
- [ ] 8.2 Update `pi-plugins/flow/intentions/scold-reminder/` docs to reference the liveness upgrade; cross-link this proposal.
- [ ] 8.3 Deploy via `pi-plugins` deploy chain (`mise run deploy-dev` → `deploy-staging` → `deploy-prod` per the staged pipeline). Verify heartbeat file appears on first fire and `/scold-restart` works in a live session.
- [ ] 8.4 Cross-reference `add-curator-lifecycle`: note in its proposal that the curator inherits this liveness pattern (heartbeat + UI indicator + restart contract).

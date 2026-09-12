## Why

`scold-reminder` is an in-process pi extension (random / embedding-matched
accountability reminder injection via hook). Today it **degrades to SILENCE** on
failure: if its hook throws (TEI unreachable, config invalid, JSON write fails),
it silently swallows the error. There is no UI indicator that it has stopped
firing, no way to know it is dead, and no restart path. The user discovered
this during the 2026-06-20 curator explore session and locked the demand:

> "OH, scold-reminder degrades silence? ... Must have the status of the pi UI
> to shows it. Then have the slash cmd to restart it again for recover."
> "remind me this afterward" — this proposal IS that afterward.

This change makes scold-reminder **observable and recoverable** while keeping
it in-process for cheap, deterministic nudges.

> **Governance split (note this clearly):** this proposal is **tracked** in
> `pi-acp-agents/openspec/changes/upgrade-scold-reminder-liveness/` because the
> user asked to "make all of them into ../pi-acp-agents". The actual **code
> change** lands in **`pi-plugins/profile/extensions/scold-reminder/`** — that
> is where scold-reminder lives. No code touches `pi-acp-agents/src/`.

## What Changes

- scold-reminder writes a **heartbeat file** at
  `~/.pi-scold-reminder/heartbeat.json` on every fire/inject attempt. Reuses
  the **teams `heartbeat-lease.ts` pattern** (atomic write + timestamp-age
  staleness math) verbatim. scold-reminder is NOT a side-car — the heartbeat is
  just a timestamp file the in-process extension writes each time it runs.
- A **staleness check** (in the same extension's `turn_end` hook, lightweight —
  one file read per turn) reads the heartbeat file and classifies state as
  `live` / `stale` / `dead` / `error` based on `lastFireAt` age vs. expected
  interval × N.
- A **UI indicator** (`ctx.ui.setStatus` and/or `ctx.ui.notify`) surfaces
  scold-reminder state. **UI-ONLY** — must NOT inject into conversation context
  (per AGENTS.md indicator-visibility rule; only safety / rule-violation
  messages persist).
- A **slash command** `/scold-restart` (or `/scold-reminder restart`) that
  re-enables the extension, clears stale state, re-reads config. NON-BLOCKING.
- **Failure mode hardened**: if the hook throws, it MUST log to UI (not
  silently swallow) AND write `phase: "error"` (+ `lastError`, `errorAt`) to
  the heartbeat file so the UI indicator flips to `error`.
- **Self-recover**: on `session_start`, if the heartbeat file shows `error` or
  `stale`/`dead` from a prior session, surface a UI warning prompting
  `/scold-restart`.

## Capabilities

### New Capabilities
- `scold-reminder-liveness`: heartbeat file, staleness classification, UI
  indicator (live/stale/dead/error), and self-recover-on-session-start. Covers
  the heartbeat schema, write cadence, atomic-write contract, staleness math
  thresholds, and the "must NOT persist into conversation context" rule.
- `scold-reminder-restart`: the `/scold-restart` (alias `/scold-reminder restart`)
  slash command — re-enable, clear stale state, re-read config, refresh
  heartbeat. NON-BLOCKING by contract.

### Modified Capabilities
<!-- None — scold-reminder has no prior OpenSpec capability in this repo. -->
_(none)_

## Impact

- **Code**: `pi-plugins/profile/extensions/scold-reminder/` (in-process pi
  extension) — new heartbeat-writer module (reusing teams'
  `heartbeat-lease.ts` pattern), staleness classifier, UI indicator calls,
  `/scold-restart` slash command registration, hardened try/catch on existing
  hook entrypoints, session-start self-recover warning.
- **No code in `pi-acp-agents/`** — this repo only holds the proposal/specs.
- **APIs**: One new slash command (`/scold-restart`). No public API changes.
- **Dependencies**: None external. Reuses existing pi UI APIs
  (`ctx.ui.setStatus` / `ctx.ui.notify`). Reuses teams' `heartbeat-lease.ts`
  staleness math conceptually (copy the timestamp-age pattern; no npm dep).
- **Runtime**: One new file at `~/.pi-scold-reminder/heartbeat.json` (atomic
  write + lock file). Negligible I/O — one write per fire, one read per turn.
- **Tests**: scold-reminder extension tests for heartbeat write, staleness
  classification thresholds, error-phase write on hook throw, slash-command
  restart path, self-recover-on-start warning.
- **Cross-reference**: `add-curator-lifecycle` — the curator (out-of-process)
  plugin will **inherit this liveness pattern**. This proposal establishes it
  for the **in-process** form first; the curator extends the same heartbeat +
  UI-indicator + restart contract to its own sidecar lifecycle.

## Why

The 2026-07-26 benchmark (`flow/findings/2026-07-26_acp-vs-subagents-benchmark.md` in pi-plugins) exposed that `pi-acp-agents` cannot match `pi-subagents` on complex multi-step work: 2 of 3 ACP sessions completed silently with zero output, no progress telemetry exists, and one-shot sessions (`idleTtlMs:0`) cannot be steered or resumed mid-flight. The benchmark's auditor flagged the async-messaging conclusion as "under-tested" (only one-shot sessions were exercised), which itself signals a missing primitive. Aligning ACP closes a real capability gap so the same workload that subagents handled (16 files across 2 areas) becomes reproducible on the ACP side.

## What Changes

- **Async spawning**: `acp_spawn` SHALL support `async: true` to return a `runId` immediately and execute the prompt in the background, mirroring subagents' `async:true` parallel mode. The existing `idleTtlMs:0` one-shot path stays as the fire-and-forget fast lane.
- **Run status & progress telemetry**: A new `acp_status({ action: "status", id })` SHALL expose per-run `state` (`prompting`/`running`/`needs-attention`/`completed`/`failed`), `turns`, `toolCalls`, `tokensUsed`, `lastActivityAt`, and `outputPath`. Fleet view (`acp_status({ view: "fleet" })`) SHALL list all active async runs in one call.
- **Live steer for async runs**: `acp_msg({ action: "send", session_id, message, kind: "steer" })` SHALL inject a message into a running async session's active turn (or queue as followUp if no active turn). Disposed one-shot sessions stay non-steerable (legacy).
- **Resume / interrupt control**: `acp_status({ action: "interrupt", id })` SHALL abort the in-flight turn; `acp_status({ action: "resume", id, message })` SHALL revive a paused/completed/failed async run with new guidance.
- **Silent-failure guard**: When an async run's ACP session reports `completed-oneshot` but produced no file writes / no tool calls, the run SHALL be marked `failed` with reason `"silent-no-output"` instead of `completed`, so callers can retry.
- **Per-run worktree isolation**: `acp_spawn({ worktree: true })` SHALL create an isolated git worktree for the run, scoped to the run's `cwd`, removed on dispose. Default remains shared cwd for backward compat.
- **Error recovery**: Failed async runs (rate limit, crash, silent) SHALL be retryable via `acp_status({ action: "resume", id })` without spawning a fresh session.

## Capabilities

### New Capabilities
- `async-run-lifecycle`: Async spawning, status/progress telemetry, steer/interrupt/resume for background ACP runs (mirrors pi-subagents async surface).
- `silent-failure-detection`: Detect and flag async runs that complete without producing artifacts, so callers can retry instead of trusting a false success.

### Modified Capabilities
- `persistent-workers`: Add live steer for in-flight worker turns and worktree isolation per worker spawn. Existing worker identity, auto-claim, and shutdown behavior unchanged.

## Impact

- **Code**: `src/core/` (async executor, run registry, status aggregator), `src/management/` (run-store, worktree manager), `src/hooks/` (wake-subscriber to surface async completions), `index.ts` (tool wiring), `src/public-api.ts` (typed exports).
- **Tools exposed to LLM**: `acp_spawn` gains `async`, `worktree` params; `acp_status` gains `action`, `view`, `id`, `index` params; `acp_msg` gains `kind: "steer"` for async runs.
- **Specs**: New `async-run-lifecycle`, `silent-failure-detection`; delta to `persistent-workers`.
- **Dependencies**: None new — uses existing ACP transport, `WorkerStore` patterns, and pi's git worktree primitives.
- **Backward compat**: All new behavior is opt-in (`async:true`, `worktree:true`). Existing one-shot spawn path and worker API unchanged.
- **Evidence source**: Benchmark finding `flow/findings/2026-07-26_acp-vs-subagents-benchmark.md` (pi-plugins) — "ACP Weaknesses" list items 1–5 and "Comparison" table gaps (async messaging, progress tracking, error recovery, worktree isolation).

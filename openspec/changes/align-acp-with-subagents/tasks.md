## 1. Type & Schema Extensions

- [ ] 1.1 Extend `AcpAsyncRunRecord` in `src/config/types.ts` with optional fields: `turns?: number`, `toolCalls?: number`, `tokensUsed?: number`, `lastActivityAt?: string`, `filesWritten?: number`, `outputPath?: string`, `worktreePath?: string`, `keepWorktree?: boolean`
- [ ] 1.2 Add `AcpAsyncRunState` value `"needs-attention"` to the state union type
- [ ] 1.3 Add `AsyncRunError` interface with `reason: "silent-no-output" | "rate-limit" | "crash" | "unknown"` field

## 2. Async Executor Telemetry

- [ ] 2.1 Update `AsyncExecutor` to subscribe to `session/update` events and accumulate `turns`, `toolCalls`, `tokensUsed`, `lastActivityAt` into the run record
- [ ] 2.2 Add `filesWritten` tracking — count file-modifying tool calls (`write`, `edit`, `replace`) from session events
- [ ] 2.3 Add `outputPath` field — set to run's output log path on spawn
- [ ] 2.4 Update `AsyncExecutor.getRun(id)` to return full telemetry-enriched record
- [ ] 2.5 Add `AsyncExecutor.listActive()` — returns all non-terminal runs sorted by `lastActivityAt` desc

## 3. Silent-Failure Detection

- [ ] 3.1 Add post-completion hook in `AsyncExecutor` that checks `toolCalls === 0 && filesWritten === 0` after session transitions to terminal state
- [ ] 3.2 When silent condition detected, override run state to `"failed"` with `error: "silent-no-output"` and append diagnostic note to output log
- [ ] 3.3 Emit wake event to parent session via wake-subscriber when silent failure detected (include `runId` and `reason`)
- [ ] 3.4 Add unit tests for silent-failure detection (zero-output → failed, with-output → completed)

## 4. Steer / Interrupt / Resume for Async Runs

- [ ] 4.1 Extend `acp_msg` tool schema to accept `kind: "steer"` parameter
- [ ] 4.2 Implement steer delivery in `AsyncExecutor`: check `busySessions` mutex, attempt provider-specific interrupt if session busy, else queue as follow-up prefix
- [ ] 4.3 Add `AsyncExecutor.interrupt(runId)` — abort in-flight turn, set state to `"needs-attention"`, preserve accumulated telemetry
- [ ] 4.4 Add `AsyncExecutor.resume(runId, message?)` — re-engage session, set state to `"running"`, reset silent-detection counters
- [ ] 4.5 Wire `acp_status({ action: "interrupt", id })` and `acp_status({ action: "resume", id, message })` to the new methods
- [ ] 4.6 Add unit tests for steer injection (in-flight → interrupt, idle → queue), interrupt, and resume

## 5. Fleet View & Status Telemetry

- [ ] 5.1 Add `acp_status({ view: "fleet" })` — returns compact list of active runs with `runId`, `state`, `agent`, `lastActivityAt`, `turns`, `toolCalls`, `tokensUsed`, `summary`
- [ ] 5.2 Filter out inactive runs older than 24h (configurable `fleetRetentionMs`)
- [ ] 5.3 Sort fleet entries by `lastActivityAt` descending
- [ ] 5.4 Add `acp_status({ action: "status", id })` — returns full telemetry for a single run
- [ ] 5.5 Add unit tests for fleet view (active runs, empty fleet, retention filter)

## 6. Worktree Isolation

- [ ] 6.1 Add `worktree?: boolean` and `keepWorktree?: boolean` params to `acp_spawn` tool schema
- [ ] 6.2 Implement `WorktreeManager` class: `create(cwd, runId)` → `git worktree add`, `remove(path)` → `git worktree remove`
- [ ] 6.3 Wire `acp_spawn({ worktree: true })` to create worktree at `<cwd>/.worktrees/acp-<runId>`, set run's `cwd` to worktree path
- [ ] 6.4 Add worktree cleanup on run dispose (unless `keepWorktree: true`) — best-effort, log warning on failure
- [ ] 6.5 Add `worktree?: boolean` and `keepWorktree?: boolean` params to `acp_worker_spawn` tool schema
- [ ] 6.6 Wire worker worktree creation/cleanup using same `WorktreeManager`
- [ ] 6.7 Add unit tests for worktree create/remove, cleanup on dispose, keepWorktree opt-out

## 7. Tool Wiring & Integration

- [ ] 7.1 Update `index.ts` tool definitions to expose new `acp_spawn` params (`async`, `worktree`, `keepWorktree`)
- [ ] 7.2 Update `acp_status` tool to support `action`, `view`, `id`, `index` params
- [ ] 7.3 Update `acp_msg` tool to support `kind: "steer"` parameter
- [ ] 7.4 Update `src/public-api.ts` exports for new types and methods
- [ ] 7.5 Add integration test: spawn async run → check fleet → steer → interrupt → resume → verify telemetry

## 8. Documentation & Migration

- [ ] 8.1 Update `README.md` with new async spawn, steer, resume, worktree examples
- [ ] 8.2 Update `SKILL.md` with new tool parameters and usage patterns
- [ ] 8.3 Add migration note: all changes additive, no breaking changes, existing one-shot path unchanged
- [ ] 8.4 Run `bun run test` — verify all existing tests pass
- [ ] 8.5 Run `bun run test --coverage` — verify no coverage regression

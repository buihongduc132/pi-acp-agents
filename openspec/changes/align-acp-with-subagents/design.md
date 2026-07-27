## Context

`pi-acp-agents` already has `AsyncExecutor` (file-backed run store) and `WorkerStore`/`WorkerDispatcher` (persistent workers). The benchmark against `pi-subagents` (2026-07-26) showed that ACP's async path is incomplete: no progress telemetry, no steer/resume for one-shot sessions, silent-failure detection missing, and no worktree isolation. Subagents produced 62% more output on the same workload. The existing `AcpAsyncRunRecord` type has `runId`, `state`, `error` but lacks `turns`, `toolCalls`, `tokensUsed`, `lastActivityAt`, `filesWritten`, `outputPath`.

## Goals / Non-Goals

**Goals:**
- Extend `AsyncExecutor` with full telemetry (turns, tools, tokens, files, activity)
- Add steer/resume/interrupt for async runs via `acp_msg` and `acp_status`
- Detect and flag silent-failure runs (completed with zero output)
- Add per-run and per-worker worktree isolation
- Maintain backward compat with existing one-shot spawn and persistent workers

**Non-Goals:**
- Replace `pi-subagents` — ACP and subagents remain complementary
- Implement DAG-level async — DAG execution already has its own lifecycle
- Change the ACP transport protocol — all changes are in the pi extension layer
- Auto-retry on rate limits — caller decides via resume

## Decisions

### D1: Extend `AcpAsyncRunRecord` with telemetry fields

**Decision:** Add `turns`, `toolCalls`, `tokensUsed`, `lastActivityAt`, `filesWritten`, `outputPath` to `AcpAsyncRunRecord`. Update `AsyncExecutor` to accumulate these from `session/update` events.

**Rationale:** Mirrors subagents' fleet view. File-backed store already exists — just extend the schema. No new persistence mechanism needed.

**Alternatives considered:**
- New `RunTelemetryStore` — rejected, adds complexity; telemetry belongs with run record
- In-memory only — rejected, loses telemetry on restart; file-backed is consistent

### D2: Reuse `WorkerDispatcher` busy mutex for async runs

**Decision:** Async runs share the `busySessions` mutex with workers. If a session is busy (worker or async run), steer injection attempts interrupt; if no active turn, steer queues as follow-up.

**Rationale:** Avoids duplicating the busy-tracking logic. Workers and async runs both use ACP sessions — same mutex semantics apply.

**Alternatives considered:**
- Separate mutex per async run — rejected, adds complexity without benefit
- No mutex — rejected, steer could race with turn completion

### D3: Silent-failure detection via post-completion audit

**Decision:** After a session transitions to `completed-oneshot` or `completed`, check `toolCalls === 0 && filesWritten === 0`. If true, override state to `failed` with `error: "silent-no-output"`. Run within 1s of terminal event.

**Rationale:** Simple, deterministic check. No false positives for legitimate "no-op" runs because any real work produces at least one tool call or file write.

**Alternatives considered:**
- Heuristic-based (e.g., "no output in last 30s") — rejected, too many false positives
- LLM-judged — rejected, expensive and slow

### D4: Worktree isolation via git worktree primitives

**Decision:** `acp_spawn({ worktree: true })` creates a git worktree at `<cwd>/.worktrees/acp-<runId>`. Cleanup on dispose unless `keepWorktree: true`. Uses `git worktree add` / `git worktree remove` — same primitives subagents use.

**Rationale:** Consistent with subagents' worktree isolation. Git worktrees are cheap (no copy). Cleanup on dispose prevents accumulation.

**Alternatives considered:**
- Copy-based isolation — rejected, expensive and slow for large repos
- Docker isolation — rejected, overkill for test-writing tasks

### D5: Steer injection via existing `acp_msg` with `kind: "steer"`

**Decision:** Extend `acp_msg` to accept `kind: "steer"` for async runs. Delivery logic: attempt provider-specific interrupt (if supported), else queue as follow-up prefix.

**Rationale:** Reuses existing `acp_msg` surface. LLM already knows `acp_msg` for session communication. Adding `kind` is minimal API surface expansion.

**Alternatives considered:**
- New `acp_run_steer` tool — rejected, duplicates `acp_msg` surface
- Steer via `acp_prompt` — rejected, `acp_prompt` is for new prompts, not mid-turn injection

## Risks / Trade-offs

**[Risk] Telemetry accumulation adds overhead** → Mitigation: Only accumulate on `session/update` events (already emitted). No polling. File writes are append-only (existing pattern).

**[Risk] Silent-failure detection false positives** → Mitigation: Only flag if `toolCalls === 0 && filesWritten === 0`. Legitimate "no-op" runs (e.g., "check status") should set `async: false` or accept the flag.

**[Risk] Worktree cleanup fails (e.g., uncommitted changes)** → Mitigation: Log warning, do not block dispose. User can manually clean up. `keepWorktree: true` opt-out available.

**[Risk] Steer injection races with turn completion** → Mitigation: Use existing `busySessions` mutex. If turn completes before steer delivered, queue as follow-up. No data loss.

**[Trade-off] File-backed telemetry vs in-memory** → Chose file-backed for consistency with existing stores. Trade-off: slightly slower than in-memory, but survives restarts and is inspectable.

**[Trade-off] Per-run worktree vs shared cwd** → Default remains shared cwd for backward compat. `worktree: true` opt-in for isolation. Trade-off: users must explicitly opt in, but existing workflows unchanged.

## Migration Plan

1. Extend `AcpAsyncRunRecord` type (additive, no breaking changes)
2. Update `AsyncExecutor` to accumulate telemetry from `session/update` events
3. Add silent-failure detection in `AsyncExecutor` post-completion hook
4. Extend `acp_msg` to accept `kind: "steer"` (additive)
5. Add `worktree` param to `acp_spawn` and `acp_worker_spawn` (additive, default false)
6. Update tool schemas in `index.ts` to expose new params
7. Deploy via existing deploy pipeline (no config changes required)

**Rollback:** All changes are additive. Revert to previous version if issues arise. No data migration needed (new fields are optional).

## Open Questions

- **Q1:** Should `filesWritten` be tracked via `session/update` events or via filesystem watch? → Leaning toward `session/update` (tool call tracking) for simplicity.
- **Q2:** Should silent-failure detection be configurable (opt-out)? → Leaning toward always-on; users can ignore the flag if not relevant.
- **Q3:** Should worktree cleanup be atomic (all-or-nothing) or best-effort? → Leaning toward best-effort (log warning, continue).

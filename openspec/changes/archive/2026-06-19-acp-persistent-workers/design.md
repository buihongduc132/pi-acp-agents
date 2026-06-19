## Context

`pi-acp-agents` exposes delegation through `AgentCoordinator.delegate()`, which creates a fully isolated short-lived ACP session per call: spawn subprocess → initialize → newSession → prompt → dispose. There is no persistent worker identity, no autonomous task dispatch, and no live control of a running agent.

Three internal modules already exist for this purpose but are **unwired**:

- `WorkerStore` (`src/management/worker-store.ts`) — file-backed store with `register/get/list/updateStatus/assignTask`. Never called by `delegate()` and not registered as a tool.
- `AcpTaskStore.claimNextAvailable()` — picks the next unblocked, unassigned, non-completed task. Nothing drives it.
- `AsyncExecutor` (`src/core/async-executor.ts`) — background delegation tracking. Used by `acp_delegate_parallel` but not by a worker loop.

The pi-agent-teams plugin implements the full worker lifecycle (`teams/worker.ts:runWorker`, `teams/teammate-rpc.ts`, `teams/heartbeat-lease.ts`), but those are pi-internal teammates. This change ports the **worker abstraction** (identity + loop + heartbeat + steer) to ACP agents, which are external processes over ACP JSON-RPC stdio.

**Constraints:**
- ACP agents are external processes — no shared filesystem, no native context fork.
- ACP `session/update` events carry tokensIn/tokensOut/tool activity → usable for liveliness signals.
- pi's tool surface is consolidated (7-tool pattern in `index.ts`); new worker tools should follow the same consolidation style.
- Per AGENTS.md, all new code must be non-blocking and exception-safe at hook boundaries.

## Goals / Non-Goals

**Goals:**
- G-A: Persistent named worker identity bound to a long-lived ACP session.
- G-C: Background `WorkerDispatcher` auto-claims unblocked tasks for idle workers.
- G-B: Live `acp_worker_steer` injects into an active ACP turn (with graceful fallback when provider lacks native interrupt).
- G-J: Heartbeat-based `online|idle|busy|stale` status derived from ACP `session/update` activity.
- G-K: Graceful handshake shutdown + force kill + stale prune.
- LIVELINESS-1: Per-worker status row shows `tok=<n> · tools=<n> · <age>s ago` + `⚠ stale` indicator.

**Non-Goals:**
- G-E context branching — separate change (`acp-context-branching.md`).
- G-F worktree isolation — DEFERRED.
- G-D hooks — separate change; this change emits `worker_spawn`/`worker_shutdown` events but does not implement the hook engine itself.
- Provider-native context forking (not viable for external ACP processes).
- Cross-machine worker coordination (single-machine, file-backed only).
- DAG orchestration — separate `acp-dag-delegation` change; workers are an execution backend once landed.

## Decisions

### D1: Worker = named ACP session bound in `WorkerStore`
A worker is identified by a user-chosen `name` (unique within the runtime dir). On spawn, we register `{ name, agentName, sessionId, status: "online", spawnedAt, lastActivityAt }` in `WorkerStore`. The ACP session behind it is kept alive (not disposed) until `shutdown`/`kill`/auto-expire. Reusing the existing `SessionManager` keeps session lifecycle consistent with `acp_prompt`/`acp_delegate`.

### D2: `WorkerDispatcher` runs in-process on a timer
A single `setInterval` (default 5s) iterates workers with `status: "idle"`, calls `AcpTaskStore.claimNextAvailable()` to get the next unblocked task, builds the task prompt (mirror `teams/worker.ts:buildTaskPrompt`), and calls `acp_prompt` on the worker's bound session. On completion, the worker returns to `idle` and re-loops. Config: `workerAutoClaim` (default `true`), `workerClaimIntervalMs` (default `5000`).

Rationale: in-process is simplest and dies with the pi session — acceptable for a single-machine coordination layer. A separate watcher process is open-question Q1; deferred.

### D3: Steer uses ACP `session/prompt` with provider-interrupt fallback
`acp_worker_steer({ name, message })` resolves the worker's active session. If the agent has an in-flight turn, attempt native interrupt (ACP `session/prompt` with a high-priority flag, or provider-specific — research needed). If no in-flight turn, queue the steer as a prefix to the next prompt the dispatcher issues. Distinct from `acp_message` (mailbox, passive).

### D4: Heartbeat derived from ACP `session/update` events
Every `session/update` (token delta, tool call, text) updates `lastActivityAt` on the worker record. `acp_worker_list` derives:
- `online` — activity within last `workerOnlineMs`
- `idle` — no in-flight task, activity within `workerStaleMs`
- `busy` — in-flight task
- `stale(<age>s)` — no activity for > `workerStaleMs` (default 60000)

Stale workers are **surfaced, not auto-killed** — the leader decides whether to `prune` or `kill`.

### D5: Graceful shutdown = finish turn → persist → dispose
`acp_worker_shutdown({ name | all })` waits up to `workerShutdownTimeoutMs` for the current turn to finish, persists task state (task → `pending` if incomplete), disposes the ACP session, and marks the worker `offline`. `acp_worker_kill({ name })` force-disposes (SIGTERM→SIGKILL) and unassigns active tasks. `acp_worker_prune()` marks stale non-responsive workers `offline` and unassigns their tasks.

### D6: Liveliness counters from ACP `session/update` fields
- **Token count**: cumulative `tokensIn + tokensOut` from `session/update` deltas.
- **Tool-call count**: increment on each `session/update` carrying tool/progress activity.
- **Last-activity age**: `now - lastActivityAt`.
- Display: `tok=<n> · tools=<n> · <age>s ago`. If all three frozen beyond `stallTimeoutMs` (existing config), render `⚠ stale`.

This is the source of the heartbeat in D4 — single event stream, two consumers.

### D7: Tool consolidation
Follow the existing 7-tool pattern. Either:
- (A) Single `acp_worker` tool with `action: "spawn|list|steer|shutdown|kill|prune"`, OR
- (B) One tool per action for discoverability.

**Decision**: Option B (one per action) for v1 — matches pi-agent-teams' tool surface where each lifecycle action is distinct, and the LLM benefits from explicit tool names. Consolidation can happen later if the tool list grows too long.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| In-process dispatcher dies with pi session → workers orphaned | `WorkerStore` is file-backed; on next pi start, idle workers are re-detected (Q1 in plan: persist session IDs for resume). v1 surfaces orphaned workers as `stale` for manual `prune`. |
| Provider lacks native steer interrupt → steer degrades to queued prompt | D3 fallback path is explicit; behavior documented in tool description so LLM knows steer may not be immediate. |
| Heartbeat gives false-positive `stale` on long-running tool calls (no `session/update` mid-tool) | `lastActivityAt` also updates on tool-call start events, not just completion. Document that `stale` is advisory, not authoritative. |
| Concurrent dispatcher + manual `acp_prompt` on same session → busy mutex violation | Reuse `SessionManager`'s busy mutex (already prevents concurrent prompts). Dispatcher skips `busy` workers. |
| Token/tool counters overflow or drift if `session/update` fields are malformed | Defensive parsing; treat missing fields as zero-delta. Log malformed events via `AcpEventLog`. |
| Auto-claim picks a task the worker's agent can't perform (capability mismatch) | Out of scope for v1 (deferred-agent-capability-validation.md). Trust the LLM/user to assign correctly; errors surface at runtime. |

## 1. Worker Identity (G-A)

- [x] 1.1 Extend `AcpWorkerRecord` type (`src/config/types.ts`) with `lastHeartbeatAt`, `tokenCountTotal`, `toolCallCount`, `currentTaskId` fields
- [x] 1.2 Add `assignTask(name, taskId)` and `unassignTask(name)` methods to `WorkerStore` (`src/management/worker-store.ts`) — wire the existing dead-code `WorkerStore.assignTask` to actually mutate `currentTaskId` and persist
- [x] 1.3 Add `WorkerStore.touch(name)` method — updates `lastHeartbeatAt` + `lastActivityAt` to now; used by heartbeat consumer (D6)
- [x] 1.4 Register `acp_worker_spawn` tool in `index.ts` — params `{ name, agent, cwd?, model?, thinking?, initPrompt? }`; creates ACP session via `SessionManager`, registers in `WorkerStore`, returns `{ name, sessionId, status: "online" }`
- [x] 1.5 Register `acp_worker_list` tool in `index.ts` — params `{ filter? }`; returns all workers with status + liveliness counters (tokenCountTotal, toolCallCount, age)

## 2. Heartbeat and Liveliness (G-J, LIVELINESS-1)

- [x] 2.1 Add heartbeat consumer to `SessionManager` event stream — on every ACP `session/update` for a worker-bound session, call `WorkerStore.touch(name)` and increment `tokenCountTotal` (from `tokensIn + tokensOut` delta) and `toolCallCount` (on tool/progress events)
- [x] 2.2 Add defensive parsing for malformed `session/update` fields — treat missing token/tool fields as zero-delta; log malformed events via `AcpEventLog`
- [x] 2.3 Implement status derivation in `acp_worker_list` — `online` (activity < `workerOnlineMs`), `idle` (no in-flight task, activity < `workerStaleMs`), `busy` (in-flight task), `stale(<age>s)` (activity > `workerStaleMs`)
- [x] 2.4 Implement `⚠ stale` indicator — when `tokenCountTotal`, `toolCallCount`, AND `lastActivityAt` are all frozen beyond `stallTimeoutMs`, append `⚠ stale` to the status row
- [x] 2.5 Format status row as `tok=<n> · tools=<n> · <age>s ago` per LIVELINESS-1 spec
- [x] 3.6 Add config: `workerAutoClaim` (default `true`), `workerClaimIntervalMs` (default `5000`) to `AcpConfig` (`src/config/config.ts`)
- [x] 5.5 Add config: `workerShutdownTimeoutMs` (default `30000`), `workerOnlineMs` (default `60000`), `workerStaleMs` (default `60000`) to `AcpConfig`

## 3. Background Auto-Claim Dispatch (G-C)

- [x] 3.1 Create `src/coordination/worker-dispatcher.ts` — `WorkerDispatcher` class with `start()` / `stop()` methods; uses `setInterval` with `workerClaimIntervalMs` (default 5000)
- [x] 3.2 Implement `dispatchOnce()` — iterate `WorkerStore.list({ status: "idle" })`; for each idle worker, call `AcpTaskStore.claimNextAvailable()`; if a task is claimed, build task prompt (mirror `teams/worker.ts:buildTaskPrompt`), call `acp_prompt` on worker's session, set `WorkerStore.updateStatus(name, "busy")` + `assignTask(name, taskId)`
- [x] 3.3 Implement round-robin / FIFO worker selection when multiple idle workers compete for tasks
- [x] 3.4 Implement turn-completion handler — when `acp_prompt` returns, mark task `completed` (or `pending` if failed), set `WorkerStore.updateStatus(name, "idle")`, `unassignTask(name)`
- [x] 3.5 Respect `SessionManager` busy mutex — skip workers that are `busy` or whose session has an in-flight prompt
- [x] 3.6 Add config: `workerAutoClaim` (default `true`), `workerClaimIntervalMs` (default `5000`) to `AcpConfig` (`src/config/config.ts`)
- [x] 3.7 Wire `WorkerDispatcher.start()` on extension init in `index.ts` when `workerAutoClaim` is true; `stop()` on pi shutdown
- [x] 3.8 Disable auto-claim when `workerAutoClaim: false` — dispatcher SHALL NOT run; workers only receive tasks via explicit `acp_prompt`

## 4. Live Steer (G-B)

- [x] 4.1 Register `acp_worker_steer` tool in `index.ts` — params `{ name, message }`; resolve worker's session; if busy, attempt interrupt; if idle, queue as next-prompt-prefix
- [x] 4.2 Research ACP provider-specific interrupt mechanism (ACP `session/prompt` with high-priority flag, or Gemini/Codex native interrupt) — document findings in `flow/findings/` or inline
- [x] 4.3 Implement interrupt attempt for in-flight workers — call provider-specific interrupt; on success return confirmation; on failure (provider doesn't support) queue steer and return warning
- [x] 4.4 Implement queue-as-next-prompt-prefix for idle workers — store steer message in `WorkerStore` metadata; dispatcher prepends it to the next task prompt
- [x] 4.5 Return error if worker not found: `"Worker '<name>' not found"`

## 5. Graceful and Force Lifecycle Control (G-K)

- [x] 5.1 Register `acp_worker_shutdown` tool — params `{ name | all }`; for each named worker (or all), wait up to `workerShutdownTimeoutMs` (default 30000) for in-flight turn to finish, persist task state, dispose session, mark `offline`
- [x] 5.2 Implement graceful shutdown of busy worker — wait for turn completion (with timeout); if completes, persist task result; if times out, return error `"Shutdown timed out; worker '<name>' still busy. Use acp_worker_kill to force."`
- [x] 5.3 Register `acp_worker_kill` tool — params `{ name }`; SIGTERM→SIGKILL the session process, unassign active tasks (set `status: "pending"`), mark worker `offline`
- [x] 5.4 Register `acp_worker_prune` tool — find all workers with `status: stale`, unassign active tasks, mark `offline`, return list of pruned names
- [x] 5.5 Add config: `workerShutdownTimeoutMs` (default `30000`), `workerOnlineMs` (default `60000`), `workerStaleMs` (default `60000`) to `AcpConfig`

## 6. Integration and Events

- [x] 6.1 Emit `worker_spawn` event to `AcpEventLog` on `acp_worker_spawn` success (for future G-D hooks integration)
- [x] 6.2 Emit `worker_shutdown` event to `AcpEventLog` on graceful shutdown / kill
- [x] 6.3 Emit `task_assigned` and `task_completed` events from `WorkerDispatcher` dispatch loop
- [x] 6.4 Add `acp_worker_*` tool visibility settings to `AcpToolSettings` (loadSettings) so users can disable individual worker tools if needed
- [x] 6.5 Update `src/acp-widget.ts` to render worker section with liveliness status (`tok=<> · tools=<> · <>s ago`) and `⚠ stale` indicators

## 7. Tests

- [x] 7.1 Unit test: `WorkerStore.register` rejects duplicate names
- [x] 7.2 Unit test: `WorkerStore.touch` updates `lastHeartbeatAt` and liveliness counters
- [x] 7.3 Unit test: `WorkerDispatcher.dispatchOnce` claims unblocked task for idle worker
- [x] 7.4 Unit test: `WorkerDispatcher.dispatchOnce` skips busy workers (busy mutex respected)
- [x] 7.5 Unit test: `WorkerDispatcher.dispatchOnce` returns to idle after task completion
- [x] 7.6 Unit test: `acp_worker_steer` queues steer as next-prompt-prefix for idle worker
- [x] 7.7 Unit test: `acp_worker_shutdown` waits for busy worker turn with timeout
- [x] 7.8 Unit test: `acp_worker_kill` force-disposes and unassigns tasks
- [x] 7.9 Unit test: `acp_worker_prune` marks stale workers offline
- [x] 7.10 Unit test: status derivation logic (`online|idle|busy|stale`) from `lastActivityAt` thresholds
- [x] 7.11 Unit test: `⚠ stale` indicator triggers when all three liveliness signals frozen beyond `stallTimeoutMs`
- [x] 7.12 Integration test: full lifecycle — spawn → dispatcher assigns task → worker completes → returns to idle → graceful shutdown
- [x] 7.13 Integration test: two idle workers compete for two tasks — each gets one

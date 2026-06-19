## Why

`WorkerStore` (`src/management/worker-store.ts`) and `AcpTaskStore.claimNextAvailable()` already exist but are dead code — `AgentCoordinator.delegate()` creates short-lived isolated subprocesses disposed after one response. There is no persistent named worker identity, no auto-claim loop, no live steer, no heartbeat-based staleness detection, and no graceful handshake shutdown. Every delegation is a one-shot spawn-respond-dispose cycle, forcing the LLM to manually drive each task through the entire lifecycle. The pi-agent-teams plugin solves all of this (`teams/worker.ts`, `teams/teammate-rpc.ts`, `teams/heartbeat-lease.ts`); this change ports the equivalent capability to ACP agents.

## What Changes

- **New `WorkerDispatcher`** — background auto-claim loop that iterates idle live workers and calls `AcpTaskStore.claimNextAvailable()` to self-dispatch unblocked tasks, mirroring `teams/worker.ts:runWorker`. Configurable via `workerAutoClaim` (default `true`) and `workerClaimIntervalMs` (default `5000`).
- **Wire up `WorkerStore`** — persistent named worker identities registered on spawn: `{ name, agentName, sessionId, status, createdAt, lastHeartbeatAt }`. Currently dead code; this change connects it to the session lifecycle.
- **Live steer** (`acp_worker_steer`) — injects a message into a worker's **active** ACP session turn (not a mailbox queue). Requires provider-specific interrupt research for ACP; falls back to queuing as next-prompt-prefix if no native interrupt exists.
- **Heartbeat / staleness tracking** — workers track `lastResponseAt` via ACP `session/update` events; `acp_worker_list` derives `online | idle | busy | stale(<age>s)` from heartbeat age vs `workerStaleMs` (default `60000`). Stale workers are surfaced, not auto-killed.
- **Graceful handshake shutdown** (`acp_worker_shutdown`) — finish current turn, persist task state, dispose session (vs current SIGTERM→SIGKILL dispose). Force `acp_worker_kill` + `acp_worker_prune` for stale cleanup.
- **Liveliness status line** (LIVELINESS-1) — every worker's status row surfaces `tok=<n> · tools=<n> · <age>s ago` derived from ACP `session/update` token/tool-call event fields, plus a `⚠ stale` indicator when all three signals freeze beyond `stallTimeoutMs`.
- **New tools registered in `index.ts`**: `acp_worker_spawn`, `acp_worker_list`, `acp_worker_steer`, `acp_worker_shutdown`, `acp_worker_kill`, `acp_worker_prune`.

## Capabilities

### New Capabilities

- `persistent-workers`: Named, long-lived ACP worker sessions with stable identity, background auto-claim task dispatch, live steer injection, heartbeat-based staleness detection, graceful/force lifecycle control, and liveliness status surfacing.

### Modified Capabilities

<!-- No existing specs to modify — this is a new capability. -->

## Impact

- **New files**: `src/coordination/worker-dispatcher.ts` (auto-claim loop), extensions to `src/management/worker-store.ts` (heartbeat, status transitions), `index.ts` (register `acp_worker_*` tools).
- **Reuses**: `AgentCoordinator`, `AsyncExecutor`, `AcpCircuitBreaker`, `HealthMonitor`, `SessionManager`, `AcpTaskStore`, `AcpEventLog`.
- **References**: `flow/findings/teams-alignment-gaps.md` gaps G-A, G-B, G-C, G-J, G-K; `flow/plans/persistent-acp-workers.md` (source plan); pi-agent-teams `teams/worker.ts:runWorker`, `teams/teammate-rpc.ts:steer`, `teams/heartbeat-lease.ts`.
- **No breaking changes** — existing `acp_delegate`/`acp_prompt` short-lived delegation remains unchanged. Workers are an opt-in layer on top.
- **Dependencies**: G-D hooks (`acp-hooks-quality-gates.md`) fires `worker_spawn`/`worker_shutdown` events once landed; G-E context branching (`acp-context-branching.md`) extends `acp_worker_spawn` with `contextMode: "branch"`.

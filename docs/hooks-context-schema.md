# ACP Hooks — Context Schema, Advisory Model & Threat Model

> Covers: LD1-LD18 implementation in `src/hooks/`
> Source of truth: `src/hooks/types.ts`, `src/hooks/hooks.ts`, `src/hooks/socket-bus.ts`, `src/hooks/policy.ts`, `src/hooks/wake-subscriber.ts`

## Hook Context Schema (LD1, LD17)

### JSON payload (`ACP_HOOK_CONTEXT_JSON`)

Passed to hook scripts via the `ACP_HOOK_CONTEXT_JSON` env var. Teams-compatible superset.

```typescript
interface HookContext {
  version: 1;
  event: HookEventName;        // one of 9 events (see Event Catalog)
  source: "acp";               // always "acp" (LD11 — own layer)
  correlationId: string;       // LD17 — UUID v4 advisory dedup key
  session: { id: string; agent: string; cwd: string };
  agent: { name: string; type: string };
  task?: {                     // present for task_* events
    id: string;
    subject: string;
    status: string;
    result?: string;           // only on task_completed
    durationMs?: number;
  };
  team?: { id: string; leadName: string };  // present when team context
  timestamp: string;           // ISO 8601
}
```

### Env vars passed to hook processes

| Env var | Content | Teams-compat |
|---------|---------|--------------|
| `ACP_HOOK_EVENT` | Event name (e.g. `task_completed`) | `PI_TEAMS_HOOK_EVENT` |
| `ACP_HOOK_CONTEXT_VERSION` | `"1"` | `PI_TEAMS_HOOK_CONTEXT_VERSION` |
| `ACP_HOOK_CONTEXT_JSON` | Full HookContext JSON | `PI_TEAMS_HOOK_CONTEXT_JSON` |
| `ACP_HOOK_CORRELATION_ID` | UUID v4 (LD17 advisory dedup) | — (ACP extension) |
| `ACP_TASK_ID` | Task ID or `""` | `PI_TEAMS_TASK_ID` |
| `ACP_TASK_SUBJECT` | Task subject or `""` | `PI_TEAMS_TASK_SUBJECT` |
| `ACP_TASK_OWNER` | `""` (reserved) | `PI_TEAMS_TASK_OWNER` |
| `ACP_TASK_STATUS` | Task status or `""` | `PI_TEAMS_TASK_STATUS` |
| `ACP_WORKER_NAME` | Agent name | `PI_TEAMS_MEMBER` |
| `ACP_AGENT_NAME` | Agent name | — |
| `ACP_SESSION_ID` | Session ID | — |
| `ACP_TIMESTAMP` | ISO 8601 | `PI_TEAMS_EVENT_TIMESTAMP` |

**cwd** = leader session's working directory.

## Event Catalog (LD8)

All 9 events implemented (delegate-model only, LD14).

**Important**: The hook script column shows the *convention*. The dispatcher discovers and runs **all** scripts in the hooks directory for **every** event — there is no per-event filename matching at the dispatcher level. To get per-event behavior, either (a) keep only the relevant script in the directory, or (b) check `$ACP_HOOK_EVENT` inside your script and exit early for non-matching events.

| Event | Trigger | Hook script convention |
|-------|---------|-------------|
| `session_started` | SessionManager.add() | `on_session_started` |
| `session_completed` | SessionManager.remove() (normal) | `on_session_completed` |
| `session_failed` | SessionManager.remove() (error) | `on_session_failed` |
| `session_idle` | HealthMonitor detects stale | `on_session_idle` |
| `subagent_start` | adapter.prompt() begins (per-turn) | `on_subagent_start` |
| `subagent_stop` | adapter.prompt() returns (per-turn) | `on_subagent_stop` |
| `task_assigned` | WorkerDispatcher dispatchOnce() | `on_task_assigned` |
| `task_completed` | Task transitions to completed | `on_task_completed` |
| `task_failed` | Task transitions to failed | `on_task_failed` |

### Hook script resolution (LD1)

```
~/.pi/agent/acp/hooks/
├── on_session_started.sh    (or .ps1, .js, .mjs, or binary)
├── on_session_completed.sh
├── on_subagent_stop.sh
├── on_task_completed.sh
└── ...
```

Resolution order per candidate: `.sh` → `.ps1` → `.js` → `.mjs` → executable binary. The dispatcher discovers **all** script files in the hooks directory and runs them in parallel for **every** event — there is no per-event filtering or single-winner resolution in the dispatcher. The resolution order applies only to `runAcpHook()` (single-path, `hooks.ts:resolveHookCommand`), not to the 3-phase dispatchers parallel discovery.

## Advisory Model (LD11, LD17)

ACP hooks are **advisory** — exit-code based, not guaranteed exactly-once.

### Failure actions (policy.ts)

| Action | Behavior |
|--------|----------|
| `warn` | Log + UI notification, continue |
| `followup` | Create remediation task |
| `reopen` | Set task back to pending |
| `reopen_followup` | Both reopen + create follow-up |

Configurable via `acp_hooks_policy_get` / `acp_hooks_policy_set` tools.

### Correlation ID (LD17)

Every hook invocation carries a UUID v4 `correlationId`. Hooks requiring exactly-once must implement own dedup using this ID:

```bash
#!/bin/bash
# on_task_completed.sh — dedup example
CORRELATION_ID="$ACP_HOOK_CORRELATION_ID"
STATE_FILE="/tmp/hook-processed-$CORRELATION_ID"
if [ -f "$STATE_FILE" ]; then exit 0; fi   # already processed
touch "$STATE_FILE"
# ... side-effecting work ...
```

### Idempotency caveat (SG5)

LD11 says double-firing is acceptable (different layers, different purposes). But non-idempotent hooks (Slack, Jira, billing, deploy) will double-act. Mitigation: use correlation ID for dedup in hooks with side effects.

## Socket Protocol (LD4, LD5, LD12, LD15)

### Wire format

JSON Lines over Unix domain socket at `~/.pi/agent/events.sock`.

```typescript
interface SocketEvent {
  "event-type": string;    // e.g. "acp.task_completed"
  "event-id": string;      // unique per event
  timestamp: string;       // ISO 8601
  source: string;          // "acp"
  payload: HookContext;
}
```

### Lifecycle (LD15, SG1)

- `unlink()` stale socket before `bind()` — only if the existing path **is** a socket (`stats.isSocket()`), to avoid clobbering regular files or directories
- `chmod(path, 0o600)` after bind
- PID file at `<socket-path>.pid`
- Single consumer for v1 (SG2 — second connection rejected, broker deferred)

### Backpressure (SG3)

Ring buffer (default 100). Drop policy:
- **Non-critical events**: drop oldest when buffer full
- **Completion events** (`task_completed`, `session_completed`, `session_failed`, `task_failed`): NEVER dropped (separate high-priority channel)

### Malformed messages (LD5)

Per-message error isolation. Invalid JSON line = skipped, next valid line processed. Connection never breaks.

### Oversized messages (LD12)

Messages exceeding `maxMessageSize` (default 1MB) are dropped entirely — **no truncation** (truncation would corrupt the JSON Lines stream).

## Wake Mechanism (LD7, LD16)

Parent pi extension subscribes to `events.sock`. On event:

```
socket event → wake-subscriber.handleEvent()
             → pi.sendUserMessage(message, { deliverAs: "followUp" })
```

**LD16**: MUST use `deliverAs: "followUp"`. Without it, `sendUserMessage` throws during streaming (parent frequently mid-turn when children complete).

### Fallback ladder

1. Socket subscriber (primary)
2. SessionManager inline
3. Intercom (safety net after 3 socket failures)

### Ring buffer replay (LD18)

Ring buffer of last 100 events replayed on reconnect after unexpected socket close (not after reload/session-switch/compact).

## Threat Model

### Shared-UID risk (G4, SG4)

`events.sock` is connectable by **any process the user owns** — browser extensions, npm-installed CLIs, anything with EXECUTE on the path.

**Mitigation**: SO_PEERCRED check rejects connections from different UID — **Linux only** (`process.platform === 'linux'`). On macOS and Windows, this check is **not active** (returns `undefined`). Same-UID processes can always connect and read events (prompts, diffs, secrets).

**Recommendation**: Document this threat to users. Do not run on shared-uid hosts without awareness. Future: per-session token authentication.

### Prompt injection via wake (G8)

Wake message content = child→parent prompt injection channel. Child-produced text flows into parent's LLM context as a user message.

**Current mitigation**: None (LD11 permits untrusted blackbox children). Document as known risk.

### Recursive wake storm (G9)

Child completion → parent wakes → parent spawns more children → cascade. No `stop_hook_active` equivalent.

**Current mitigation**: None. Document as known risk. Future: rate limiter.

## Configuration

### `~/.pi/agent/acp/hooks/config.json` (LD3)

```json
{
  "version": 1,
  "enabled": true,
  "hooks": {
    "session_started": { "enabled": true, "timeoutMs": 30000 },
    "task_completed": { "enabled": false, "timeoutMs": 60000 }
  },
  "failureAction": "warn",
  "followupOwner": "lead",
  "maxReopensPerTask": 3,
  "socket": {
    "enabled": true,
    "path": "~/.pi/agent/events.sock",  // MUST be absolute when set; Node fs/net does NOT expand ~. Default uses HOME/USERPROFILE internally.
    "maxMessageSize": 1048576,
    "broadcastTimeoutMs": 1000
  }
}
```

- `hooks[event].enabled: false` disables specific events (LD3)
- Omitted events inherit global `enabled` flag
- Malformed config → fallback to defaults (does not throw)

### Runtime policy tools

| Tool | Action |
|------|--------|
| `acp_hooks_policy_get` | Read configured + effective policy |
| `acp_hooks_policy_set` | Update failureAction, maxReopensPerTask, followupOwner |
| `reset: true` (in acp_hooks_policy_set) | Clear team-level overrides |

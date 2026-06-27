# Usage Guide — @buihongduc132/pi-acp-agents

Deep usage reference. For installation and overview see [README.md](../README.md).

## Table of Contents

- [Slash command surface](#slash-command-surface)
- [Tool reference](#tool-reference)
- [DAG delegation patterns](#dag-delegation-patterns)
- [Alias resolver + fallback chains](#alias-resolver--fallback-chains)
- [Persistent workers](#persistent-workers-1)
- [Session-scoped runtime stores](#session-scoped-runtime-stores)
- [Migration guide](#migration-guide)

---

## Slash command surface

```
/acp session <new|load|list|shutdown|kill|prune|set-model|set-mode|cancel>
/acp prompt
/acp delegate
/acp broadcast
/acp compare
/acp task <create|list|get|assign|set-status|dep-add|dep-rm|clear>
/acp message <send|list>
/acp plan <request|resolve>
/acp runtime <status|config|env|info|event-log|cleanup|doctor>
/acp settings — configure tool visibility
Aliases: /acp-doctor, /acp-config
```

`/acp settings` exposes a TUI for per-tool enable/disable. Disabled tools are NOT registered in pi, reducing token overhead.

---

## Tool reference

### Communication

#### `acp_prompt`
Send a prompt to an ACP agent, get the text response.

```jsonc
{
  "message": "What is the capital of France?",
  "agent": "gemini",              // optional, defaults to defaultAgent or alias
  "cwd": "/path/to/project",      // optional
  "dispose": false,               // optional, true = ephemeral session auto-disposed
  "session_id": "...",            // optional, reuse session
  "session_name": "my-research"   // optional, reuse or assign friendly name
}
```

If `session_id` / `session_name` provided: reuses that session. If unknown: archived session is reloaded. Otherwise: new session created. `dispose: true` removes the session from the registry and disposes the adapter after the prompt completes.

#### `acp_status`
Diagnostic — configured agents, active sessions, circuit breaker state. No params.

#### `acp_cancel`
Cancel an in-flight prompt by ID or friendly name.

```jsonc
{ "session_id": "..." }   // or { "session_name": "my-research" }
```

Calls `adapter.cancel()` (Ctrl-C equivalent), marks handle completed, archives.

#### `acp_broadcast`
Same prompt → N agents in parallel. Scoped to caller session's agents.

```jsonc
{
  "message": "Analyze this code",
  "agents": ["gemini", "claude", "codex"],  // optional, defaults to all
  "cwd": "/path"
}
```

### Tasks

#### `acp_task_create`
Create a persistent task in the runtime task store.

```jsonc
{
  "subject": "Fix auth bug",
  "description": "...",
  "assignee": "claude",       // optional
  "deps": ["task-001"]        // optional task IDs this depends on
}
```

#### `acp_task_update`
Multiplexed mutations: status, assignee, deps, result, bulk `*`.

```jsonc
// Single task
{
  "task_id": "task-001",
  "status": "in_progress",     // pending | in_progress | completed | deleted
  "assignee": "claude",        // or "" to unassign
  "deps_add": ["task-002"],
  "deps_remove": ["task-003"],
  "result": "Fixed in commit abc123"
}

// Bulk
{
  "task_id": "*",
  "filter": "completed",       // completed | pending | in_progress
  "status": "deleted"
}
```

### Messaging

#### `acp_message`
Send or list messages. Consolidates send + list.

```jsonc
// Send
{
  "action": "send",
  "to": "claude",              // or "*" for broadcast
  "message": "Please review PR #42",
  "kind": "dm"                 // dm | steer | broadcast (auto-inferred if to="*")
}

// List
{
  "action": "list",
  "recipient": "claude"        // optional, lists inbox for this agent
  // or omit for list-all
}
```

### DAG delegation

See [DAG delegation patterns](#dag-delegation-patterns) below.

### Workers

See [Persistent workers](#persistent-workers-1) below.

---

## DAG delegation patterns

### Linear pipeline

```jsonc
{
  "tasks": [
    { "id": "analyze", "agent": "gemini", "prompt": "Analyze {dag.args.codebase}" },
    { "id": "fix",     "agent": "claude", "prompt": "Fix: {analyze.output}", "dependsOn": ["analyze"] },
    { "id": "verify",  "agent": "gemini", "prompt": "Verify: {fix.output}",   "dependsOn": ["fix"] }
  ],
  "args": { "codebase": "/path/to/repo" }
}
```

### Parallel fan-out + merge

```jsonc
{
  "tasks": [
    { "id": "frontend", "agent": "gemini", "prompt": "Build UI" },
    { "id": "backend",  "agent": "claude", "prompt": "Build API" },
    { "id": "deploy",   "agent": "gemini", "prompt": "Deploy FE: {frontend.output}\nBE: {backend.output}",
      "dependsOn": ["frontend", "backend"] }
  ]
}
```

### Cleanup gate (`after`)

```jsonc
{
  "tasks": [
    { "id": "test",    "agent": "gemini", "prompt": "Run tests" },
    { "id": "teardown","agent": "gemini", "prompt": "Cleanup regardless of test outcome",
      "dependsOn": ["test"], "gate": "after" }   // runs even if test fails
  ]
}
```

### Submission options

```jsonc
{
  "tasks": [...],
  "args": {...},                         // workflow args, accessed via {dag.args.X}
  "options": {
    "failFast": true,                    // default true — fail cascades to dependents
    "maxRetries": 0                      // per-step retry on failure
  },
  "cwd": "/path/to/project"
}
```

### Persistence + resume

All DAG state persists to `<runtimeDir>/dag/`:
- `<dagId>.json` — DAG state + step results
- `dag-index.json` — index of all DAGs with summary status

On pi restart, `resumeAll()` discovers DAGs in `running` state and:
- Skips steps that reached terminal state
- Retries steps that were mid-flight
- Re-evaluates gate satisfaction

---

## Alias resolver + fallback chains

Aliases route a single logical agent name to a chain of concrete agents. Configured in `config.json`:

```jsonc
{
  "aliases": {
    "smart": {
      "strategy": "failover",       // failover (sequential) or race (parallel)
      "agents": ["gemini", "claude", "codex"]
    },
    "fast": {
      "strategy": "race",
      "agents": ["gemini", "claude"],
      "raceTimeoutMs": 30000
    }
  }
}
```

### Strategies

| Strategy | Behavior |
|---|---|
| `failover` | Try agents in array order. Skip unhealthy (circuit-open). First success wins. Throws `AllAgentsFailedError` if all fail. |
| `race` | Send to all healthy agents in parallel. First success cancels losers via `cancelFn`. Default race timeout 30s. Throws `NoHealthyAgentsError` if all circuits open. |

### Using an alias

`acp_prompt` and `acp_delegate` accept an alias name as the `agent` parameter. The resolver picks the concrete agent transparently.

```jsonc
{ "agent": "smart", "message": "Refactor the auth module" }
```

### Error types

| Error | Cause |
|---|---|
| `AllAgentsFailedError` | failover: every agent in chain failed |
| `NoHealthyAgentsError` | All circuits open at dispatch time |

---

## Persistent workers

### Spawn

```jsonc
{
  "name": "researcher-1",           // 1-64 chars, [a-zA-Z0-9_-]
  "agent": "gemini",                // agent from config
  "cwd": "/path/to/project",        // optional
  "model": "gemini-2.5-pro",        // optional override
  "thinking": "high",               // optional thinking/mode level
  "initPrompt": "You are a researcher..."  // optional, sent after session creation
}
```

### Steer (in-flight redirect)

```jsonc
{
  "name": "researcher-1",
  "message": "Actually focus only on security issues"
}
```

Injects context into the worker's active prompt.

### Lifecycle

| Tool | Purpose |
|---|---|
| `acp_worker_list` | All workers + status |
| `acp_worker_shutdown` | Graceful (waits for current prompt) |
| `acp_worker_kill` | Force kill (SIGKILL) |
| `acp_worker_prune` | Remove stale workers |

### Important caveats

- **No filesystem isolation** — workers share caller's `cwd`. Use the `teams` pi-plugin for `git worktree` per-worker isolation.
- **No context inheritance** — workers spawn with a fresh ACP session. To clone leader context use `teams` plugin's `contextMode: "branch"`.
- **Name uniqueness** — worker names must be unique within `WorkerStore`.

---

## Session-scoped runtime stores

As of `0.4.0`, runtime stores are partitioned:

### Session-scoped (4) — under `<root>/<sessionId>/`

| Store | File | Purpose |
|---|---|---|
| `AcpTaskStore` | `tasks.json` | Tasks created within session |
| `MailboxManager` | `mailboxes.json` | DM/steer/broadcast for this session's agents |
| `GovernanceStore` | `governance.json` | Plan approval, model policy |
| `WorkerStore` | `workers.json` | Persistent workers spawned in session |

### Global (3) — under `<root>/`

| Store | File | Purpose |
|---|---|---|
| `SessionNameStore` | `session-name-registry.json` | Friendly-name → session ID registry (cross-session) |
| `SessionArchiveStore` | `session-archive.json` | Archived session metadata (cross-session visibility for `acp_session_list`) |
| `AcpEventLog` | `events.jsonl` | Append-only event log |

All 4 session-scoped stores require `sessionId` and throw synchronously if empty — no silent global fallback.

---

## Migration guide

### From 0.3.x → 0.4.0

1. **DAG feature shipped** — `acp_dag_submit` / `_status` / `_cancel` tools now registered.
2. **Session-scoped stores** — runtime paths partitioned. On first run, `legacy-migration.ts` moves flat stores to `<root>/legacy/` non-destructively (idempotent, concurrency-marker guarded).
3. **DAG widget** — TUI now shows DAG state via `dagIndexEntryToWidgetDag` helper.
4. **No breaking config changes** — existing `config.json` continues to work.

### From 0.2.x → 0.3.x

1. **`acp_message` consolidated** — was `acp_message_send` + `acp_message_list`, now one tool with `action` param.
2. **`acp_task_*` consolidated** — was 5 tools, now `acp_task_create` + `acp_task_update`.
3. **Circuit breaker isolation** — per-agent, not global.

### Roadmap (multiplex)

The `ACP_TOOL_NAMES` array in `src/settings/config.ts` has 39 entries (settings toggle schema); only 13 tools are actually registered. See [tool consolidation plan](https://github.com/buihongduc132/pi-plugins/blob/main/flow/intentions/pi-acp-agents/tool-consolidation.md) for the planned 33 → 7 multiplex refactor.

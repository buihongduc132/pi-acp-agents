# @buihongduc132/pi-acp-agents

> Multi-agent orchestration for pi — spawn, control, and coordinate ACP-compatible agents (Gemini CLI, Claude, Codex, custom) as first-class tools within the pi coding agent.

[![npm version](https://img.shields.io/npm/v/@buihongduc132/pi-acp-agents.svg)](https://www.npmjs.com/package/@buihongduc132/pi-acp-agents)
[![CI](https://github.com/buihongduc132/pi-acp-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/buihongduc132/pi-acp-agents/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@buihongduc132/pi-acp-agents.svg)](https://github.com/buihongduc132/pi-acp-agents/blob/main/LICENSE)

---

## Table of Contents

- [What works vs what does not](#what-works-vs-what-does-not) ← **read this first**
- [Install](#install)
- [Quick start](#quick-start)
- [Tool surface](#tool-surface)
- [DAG delegation](#dag-delegation)
- [Alias resolver + fallback chains](#alias-resolver--fallback-chains)
- [Persistent workers](#persistent-workers)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Resilience](#resilience)
- [Logs](#logs)
- [Supported agents](#supported-agents)
- [Development](#development)
- [Release process](#release-process)
- [Further documentation](#further-documentation)

---

## What works vs what does not

Status as of `0.4.0`. Verified by full test suite (`npx vitest run` → 1627 passed / 0 failed / 83 skipped / 1 todo). Counts: **16 tools registered** (verified via `rg -c 'pi.registerTool' index.ts`), **42 entries** in `ACP_TOOL_NAMES` legacy schema.

### ✅ Working

| Capability | Notes |
|---|---|
| `acp_prompt` (single agent) | Session create / reuse / archive-reload |
| `acp_status` (diagnostic) | Agent list, sessions, circuit breaker |
| `acp_cancel` (in-flight prompt abort) | Calls `adapter.cancel()`, archives handle |
| `acp_broadcast` (one prompt → N agents) | Scoped to caller session's agents |
| `acp_task_create` / `acp_task_update` | Multiplexed: status / assignee / deps / bulk `*` filter |
| `acp_message` (send + list) | DM / steer / broadcast via `kind` param |
| `acp_dag_submit` / `acp_dag_status` / `acp_dag_cancel` | Wave-based topological DAG execution, persistent resume |
| `acp_worker_spawn` / `_list` / `_steer` / `_shutdown` / `_kill` / `_prune` | Persistent named workers in `WorkerStore` |
| **Alias resolver** (failover + race) | `AliasResolver` class — sequential fallback OR parallel first-wins with cancel of losers |
| **Circuit breaker** | 3 failures → open, 60s → half-open, auto-recover |
| **Health monitor** | 30s background polling; distinct no-response vs completed-idle timers |
| **Session-scoped stores** | `tasks`/`mailboxes`/`governance`/`workers` partitioned per host session ID; `session-archive`/`session-name-registry`/`event-log` global |
| **Legacy migration** | Non-destructive flat → `legacy/` on first run after partitioning |
| **DAG widget** | `dagIndexEntryToWidgetDag` helper renders DAG state in TUI |
| **TUI widget** | Real-time session + DAG status panel |
| **Gemini CLI adapter** | Auto-auth, default |
| **Custom adapter** | Any ACP-speaking stdio agent |
| **Stall timeout** | Per-op with SIGTERM → SIGKILL escalation |
| **EPIPE safety** | stdin/stdout broken-pipe handled |
| **Tag-triggered CI publish** | `git push --follow-tags` → npm publish with provenance |

### ❌ Not working / not implemented

| Gap | Status |
|---|---|
| **One-call parallel batch delegate** | No `acp_delegate_parallel` — must `acp_worker_spawn` × N + `acp_prompt` × N |
| **Plan approval flow as tool** | `acp_plan_request` / `acp_plan_resolve` are command-only stubs, not tools |
| **Hooks policy** | No `hooks_policy_*` — retry governance absent |
| **Model policy as tool** | `acp_model_policy_get` / `_check` are command-only |
| **Predefined teams** | No `predefined_teams_*` |
| **Workspace isolation (worktree mode)** | Workers use `cwd` only — no `git worktree` isolation |
| **Context inheritance** | No `contextMode: "branch"` (clone leader session) |
| **`task_dep_ls`** | Only add/rm via `task_update` — cannot list blockers |
| **`task_get` (single)** | Not exposed — only create + update |
| **Diagnostics as tools** | `acp_doctor`, `acp_runtime_info`, `acp_event_log`, `acp_env`, `acp_cleanup` are slash commands only |
| **Session lifecycle tools** | `acp_session_list` / `_shutdown` / `_kill` / `_prune` / `_set_model` / `_set_mode` are not exposed (automation-only) |
| **Streaming responses** | Planned — currently returns after full prompt completes |
| **Tool use forwarding** | Planned — ACP agent tool calls not relayed back to pi |
| **OAuth / token auth** | Planned — env vars only |
| **Config hot-reload** | Manual restart required |
| **Retry with backoff** | Circuit breaker handles fail-closed; no exponential backoff |
| **Session sharing across pi instances** | Single-host only |
| **Metrics export (Prometheus)** | Planned |
| **Agent routing (auto-select)** | Manual via alias or explicit |
| **Ensemble / chain-of-agents** | Manual via DAG composition |
| **Cost tracking** | Planned |
| **Claude Code / Codex ACP adapters** | Pending upstream ACP mode |

### ⚠️ Known surface drift

`src/settings/config.ts` ships a legacy `ACP_TOOL_NAMES` array of **42 entries** (a settings toggle schema) while only **16 tools are actually registered** in `index.ts`. The 26-entry delta is NOT missing tools — it is the per-tool enable/disable toggle schema for `/acp settings`. See [`../pi-plugins/flow/intentions/pi-acp-agents/tool-consolidation.md`](https://github.com/buihongduc132/pi-plugins/blob/main/flow/intentions/pi-acp-agents/tool-consolidation.md) for the planned consolidation (42 → 7 multiplexed tools).

---

## Install

### For humans

```bash
npm install @buihongduc132/pi-acp-agents
```

### For AI agents

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@buihongduc132/pi-acp-agents"]
}
```

Or:

```bash
pi install npm:@buihongduc132/pi-acp-agents
```

### Git-sourced

```json
{
  "gitPackages": [
    { "url": "https://github.com/buihongduc132/pi-acp-agents.git" }
  ]
}
```

---

## Quick start

1. Install an ACP agent (Gemini CLI default):

   ```bash
   gemini --version
   gemini  # first run to authenticate
   ```

2. (Optional) Configure:

   ```bash
   mkdir -p ~/.pi/acp-agents
   cat > ~/.pi/acp-agents/config.json << 'EOF'
   {
     "agent_servers": {
       "gemini": {
         "command": "gemini",
         "args": ["--acp"],
         "default_model": "gemini-2.5-pro"
       }
     },
     "defaultAgent": "gemini"
   }
   EOF
   ```

3. Use in pi:

   ```
   Use the acp_prompt tool to ask gemini "What is the capital of France?"
   ```

For full usage patterns, DAG examples, alias configuration, and worker orchestration see [`docs/USAGE.md`](docs/USAGE.md).

---

## Tool surface

**16 tools registered** (gated by `/acp settings` per-tool toggles):

| Tool | Purpose |
|---|---|
| `acp_prompt` | Send a prompt to an ACP agent, get the text response |
| `acp_status` | Show configured agents, active sessions, circuit breaker state |
| `acp_cancel` | Cancel an ongoing prompt by ID or friendly name |
| `acp_broadcast` | Send same prompt to multiple agents in parallel |
| `acp_task_create` | Create a persistent task in the runtime task store |
| `acp_task_update` | Multiplexed mutations: status, assignee, deps, result, bulk `*` |
| `acp_message` | Send or list messages (dm / steer / broadcast) |
| `acp_dag_submit` | Submit a DAG of tasks (validates, persists, starts background exec) |
| `acp_dag_status` | Get DAG state by `dagId`, or list all DAGs when called without it |
| `acp_dag_cancel` | Cancel a running DAG |
| `acp_worker_spawn` | Spawn a persistent named worker |
| `acp_worker_list` | List workers + status |
| `acp_worker_steer` | In-flight redirect — inject context mid-prompt |
| `acp_worker_shutdown` | Graceful shutdown |
| `acp_worker_kill` | Force kill |
| `acp_worker_prune` | Prune stale workers |

**Slash command surface** (`/acp ...`):

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

For tool-parameter reference and examples see [`docs/USAGE.md`](docs/USAGE.md).

---

## DAG delegation

Submit a complete DAG of ACP agent tasks in a single call. The DAG executor:
- **Validates statically** (cycles, dangling refs, duplicate IDs, agent availability)
- **Persists state** to disk under `<runtimeDir>/dag/`
- **Executes in topological wave-order** (parallel within wave, serial across waves)
- **Resumes automatically** after pi restart (running steps retried, completed steps skipped)

### Submission JSON

```json
{
  "tasks": [
    { "id": "analyze", "agent": "gemini", "prompt": "Analyze the codebase for security issues" },
    { "id": "fix", "agent": "claude", "prompt": "Fix the issues: {analyze.output}", "dependsOn": ["analyze"] },
    { "id": "verify", "agent": "gemini", "prompt": "Verify: {fix.output}", "dependsOn": ["fix"], "gate": "after" }
  ],
  "args": { "project": "my-app" },
  "options": { "failFast": true, "maxRetries": 0 },
  "cwd": "/path/to/project"
}
```

### Template variables

| Variable | Resolves to |
|---|---|
| `{<step-id>.output}` | Output of referenced step (truncated to `dagOutputTruncateChars`) |
| `{<step-id>.status}` | Terminal status (`completed` / `failed` / `skipped` / `cancelled`) |
| `{dag.args.<key>}` | Workflow arg from `args` at submission |

Unresolvable variables fail the step at dispatch time.

### Gates

| Gate | Behavior |
|---|---|
| `needs` (default) | **Success-gate** — all deps must `complete`. Failure cascades. |
| `after` | **Completion-gate** — deps just need a terminal state. Use for cleanup/verify steps. |

### Config

| Option | Default | Description |
|---|---|---|
| `dagStaleTimeoutMs` | `3_600_000` (1h) | No step transitions for this long → `stale` |
| `dagOutputTruncateChars` | `8000` | Max chars injected into downstream prompts |

For DAG executor internals, persistence model, and resume semantics see [`docs/USAGE.md`](docs/USAGE.md).

---

## Alias resolver + fallback chains

Resolves an alias name to a concrete agent using configurable strategies. Used internally by `acp_prompt` / `acp_delegate` when called with an alias name.

| Strategy | Behavior |
|---|---|
| **failover** (sequential) | Try agents in order; first success wins; throws `AllAgentsFailedError` if all fail |
| **race** (parallel) | Send to all healthy agents in parallel; first success cancels losers (default race timeout 30s) |

Both strategies consult the circuit breaker (`isHealthyFn`) before dispatching and skip unhealthy agents.

For alias configuration schema and examples see [`docs/USAGE.md`](docs/USAGE.md).

---

## Persistent workers

Spawn long-lived named workers via `acp_worker_spawn`. Workers persist across task completions and are managed via:

| Tool | Purpose |
|---|---|
| `acp_worker_spawn` | Spawn worker + bind to ACP session + optional init prompt |
| `acp_worker_list` | List workers + status (online / offline / busy / disposed) |
| `acp_worker_steer` | In-flight redirect — inject context mid-prompt |
| `acp_worker_shutdown` | Graceful shutdown |
| `acp_worker_kill` | Force kill |
| `acp_worker_prune` | Prune stale workers |

Workers share the caller's filesystem (no `git worktree` isolation). For parallel worktree-isolated delegation use the `teams` pi-plugin instead.

---

## Configuration

Config file: `~/.pi/acp-agents/config.json`

```json
{
  "agent_servers": {
    "gemini": { "command": "gemini", "args": ["--acp"], "default_model": "gemini-2.5-pro" },
    "custom": { "command": "/path/to/my-acp-agent", "args": ["--mode", "acp"] }
  },
  "defaultAgent": "gemini",
  "staleTimeoutMs": 3600000,
  "healthCheckIntervalMs": 30000,
  "circuitBreakerMaxFailures": 3,
  "circuitBreakerResetMs": 60000,
  "stallTimeoutMs": 3600000
}
```

### Global

| Field | Default | Description |
|---|---|---|
| `agent_servers` | `{ gemini: {...} }` | Map of agent name → config |
| `defaultAgent` | `"gemini"` | Agent used when not specified |
| `staleTimeoutMs` | `3600000` (1h) | Auto-close: stalled-no-response AND completed-idle |
| `healthCheckIntervalMs` | `30000` (30s) | Background health polling interval |
| `circuitBreakerMaxFailures` | `3` | Consecutive failures before circuit opens |
| `circuitBreakerResetMs` | `60000` (60s) | Time before circuit half-opens |
| `stallTimeoutMs` | `3600000` (1h) | Per-operation timeout |
| `logsDir` | `~/.pi/acp-agents/logs` | Log directory |
| `dagStaleTimeoutMs` | `3600000` | DAG stale threshold |
| `dagOutputTruncateChars` | `8000` | DAG downstream prompt truncation |

### Per-agent

| Field | Required | Description |
|---|---|---|
| `command` | **yes** | Executable to spawn |
| `args` | no | Args (e.g. `["--acp"]`) |
| `env` | no | Extra env vars |
| `cwd` | no | Working dir override |
| `default_model` | no | Default model ID |

For aliases, model policy, and runtime store paths see [`docs/USAGE.md`](docs/USAGE.md).

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    pi agent                          │
│                                                      │
│  acp_prompt ──┐                                      │
│  acp_status ──┤                                      │
│  acp_cancel ──┤──► AliasResolver ──► Coordinator ──┐ │
│  acp_dag_* ───┤                       │            │ │
│  acp_worker_* ┤                       ▼            │ │
│  acp_message ─┤              AcpCircuitBreaker     │ │
│  acp_task_* ──┘                       │            │ │
│                              ┌────────┴────────┐   │ │
│                              │ Adapter Factory │   │ │
│                              └────┬───────┬────┘   │ │
│                            GeminiAdapter│          │ │
│                                  CustomAdapter     │ │
│                                       │            │ │
│                              AcpClient (stdio)     │ │
│                                       │            │ │
│                              HealthMonitor ◄───────┤ │
│                              SessionManager        │ │
│                              DagStore + DagExecutor│ │
│                              WorkerStore           │ │
│                              SessionStoreFactory   │ │
└─────────────────────────────────────────────────────┘
```

### Patterns

| Pattern | Implementation |
|---|---|
| **Adapter** | `AcpAgentAdapter` → `GeminiAcpAdapter` / `CustomAcpAdapter` |
| **Factory** | `createAdapter()` — string dispatch |
| **Circuit breaker** | Closed → Open → Half-Open with configurable thresholds |
| **Health monitor** | Background polling; distinct no-response and completed-idle auto-close |
| **Coordinator** | Multi-agent delegate / broadcast / compare |
| **Alias resolver** | failover (sequential) + race (parallel first-wins) |
| **DAG executor** | Topological wave-execution + persistent resume |
| **Session-store factory** | Per-host-session lazy-instantiated stores (4 session-scoped + 3 global) |

---

## Resilience

| Feature | Default | Description |
|---|---|---|
| Circuit breaker | 3 failures → open | Auto-recovers after 60s in half-open state |
| Stall timeout | 1 hour | Per-operation timeout with SIGTERM → SIGKILL escalation |
| Health polling | 30s | Background monitor with separate no-response and completed-idle timers |
| Busy mutex | per-session | Prevents concurrent prompts on the same session |
| Process safety | SIGTERM → SIGKILL | Graceful shutdown with escalation |
| EPIPE handling | stdin / stdout | Prevents crashes on broken pipes |
| Non-blocking | all paths | Errors return as tool error results, never unhandled throws |
| Alias failover | automatic | Sequential fallback on agent failure |
| Alias race | 30s timeout | Parallel first-wins with cancel of losers |
| DAG resume | on pi restart | `resumeAll()` discovers running DAGs, skips completed steps |

---

## Logs

Central logs at `~/.pi/acp-agents/logs/`:

- `main.log` — general structured JSON log
- `session-{id}/trace.jsonl` — per-session ACP JSON-RPC traces
- `<runtimeDir>/dag/<dagId>.json` + `dag-index.json` — DAG state persistence
- `<runtimeDir>/<sessionId>/{tasks,mailboxes,governance,workers}.json` — session-scoped stores
- `<runtimeDir>/{events,session-archive,session-name-registry}.jsonl|json` — global stores

---

## Supported agents

| Agent | Status | Config |
|---|---|---|
| **Gemini CLI** | ✅ Built-in | `command: "gemini", args: ["--acp"]` |
| **Claude Code** | 🔜 Planned | ACP mode pending upstream |
| **Codex** | 🔜 Planned | ACP mode pending upstream |
| **Custom** | ✅ Via `CustomAcpAdapter` | Any command speaking ACP over stdio |

---

## Development

```bash
npm install
npm test              # all tests
npm run test:ci       # with coverage
npm run typecheck     # TypeScript validation
npm run publish:dry   # verify package contents before publish
```

---

## Release process

```bash
npm run release:patch    # 0.4.0 → 0.4.1
npm run release:minor    # 0.4.0 → 0.5.0
npm run release:beta     # 0.4.0 → 0.4.1-beta.0
git push --follow-tags   # triggers CI → auto-publish with provenance
```

---

## Further documentation

| Topic | Location |
|---|---|
| **Full usage guide** (DAG examples, alias config, worker patterns, slash command reference) | [`docs/USAGE.md`](docs/USAGE.md) |
| **Tool consolidation plan** (39 → 7 multiplexed tools) | [`../pi-plugins/flow/intentions/pi-acp-agents/tool-consolidation.md`](https://github.com/buihongduc132/pi-plugins/blob/main/flow/intentions/pi-acp-agents/tool-consolidation.md) |
| **ACP vs teams gap analysis** | [`../pi-plugins/flow/findings/acp-vs-teams-analysis.md`](https://github.com/buihongduc132/pi-plugins/blob/main/flow/findings/acp-vs-teams-analysis.md) |
| **DAG delegation design** | [`openspec/changes/archive/2026-06-20-acp-dag-delegation/`](openspec/changes/archive/2026-06-20-acp-dag-delegation/) |
| **DAG widget design** | [`openspec/changes/archive/2026-06-22-acp-dag-widget/`](openspec/changes/archive/2026-06-22-acp-dag-widget/) |
| **Session-scoped runtime stores** | [`openspec/changes/archive/2026-06-19-scope-runtime-stores-per-session/`](openspec/changes/archive/2026-06-19-scope-runtime-stores-per-session/) |
| **Branch consolidation record** (this release) | [`docs/branch-consolidation-2026-06-22.md`](docs/branch-consolidation-2026-06-22.md) |
| **OpenSpec changes** | [`openspec/changes/`](openspec/changes/) |
| **Specs (canonical)** | [`openspec/specs/`](openspec/specs/) |

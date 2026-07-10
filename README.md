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

Status as of `0.5.0`. Verified by full test suite (`npx vitest run` → 2081 passed / 0 failed / 104 skipped / 1 todo). Consolidated tool surface: **9 tools registered** (7 ACP core + 2 ACP hooks policy), down from the legacy 33-tool surface. See [Tool surface](#tool-surface).

### ✅ Working

| Capability | Notes |
|---|---|
| `acp_spawn` (single agent) | Spawn a session + optional prompt; absorbs legacy acp_prompt / acp_session_new |
| `acp_msg` (messaging) | Session prompt/steer/cancel + mailbox send/list; absorbs acp_message |
| `acp_status` (diagnostic) | Agent list, sessions, circuit breaker; absorbs acp_doctor / acp_runtime_info |
| `acp_fanout` (broadcast/compare) | Same prompt → N agents; absorbs acp_broadcast / acp_compare |
| `acp_governance` | Plan request/resolve + model policy |
| `acp_task` (action: create\|update) | Unified task tool: status / assignee / deps / bulk `*` filter |
| `acp_dag` (action: submit\|status\|cancel) | Wave-based topological DAG execution, persistent resume |
| `acp_hooks_policy_get` / `acp_hooks_policy_set` | Runtime hooks failure-policy inspection + mutation |
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
| **One-call parallel batch delegate** | No single-call parallel batch — use `acp_fanout` (broadcast/compare) instead of spawning N sessions manually |
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
   Use the acp_spawn tool to spawn a gemini session, then acp_msg to ask "What is the capital of France?"
   ```

For full usage patterns, DAG examples, alias configuration, and worker orchestration see [`docs/USAGE.md`](docs/USAGE.md).

---

## Tool surface

**9 tools registered** (7 ACP core + 2 hooks policy, gated by `/acp settings` per-tool toggles):

| Tool | Purpose |
|---|---|
| `acp_spawn` | Spawn a session + optional prompt (absorbs acp_prompt / acp_session_new) |
| `acp_msg` | Session prompt/steer/cancel + mailbox send/list (absorbs acp_message / acp_cancel) |
| `acp_governance` | Plan request/resolve + model policy (absorbs acp_plan_*, acp_model_policy_*) |
| `acp_status` | Agents, sessions, circuit breaker, cleanup, prune (absorbs acp_doctor / acp_runtime_info / acp_cleanup) |
| `acp_fanout` | Broadcast to N agents + compare mode (absorbs acp_broadcast / acp_compare) |
| `acp_task` | Unified task tool: action:'create' or action:'update' (absorbs acp_task_create / acp_task_update) |
| `acp_dag` | DAG delegation: action:'submit'\|'status'\|'cancel' (absorbs acp_dag_submit / _status / _cancel) |
| `acp_hooks_policy_get` | Inspect the ACP hooks failure policy |
| `acp_hooks_policy_set` | Update the ACP hooks failure policy |

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

Resolves an alias name to a concrete agent using configurable strategies. Used internally by `acp_spawn` / `acp_fanout` when called with an alias name.

| Strategy | Behavior |
|---|---|
| **failover** (sequential) | Try agents in order; first success wins; throws `AllAgentsFailedError` if all fail |
| **race** (parallel) | Send to all healthy agents in parallel; first success cancels losers (default race timeout 30s) |

Both strategies consult the circuit breaker (`isHealthyFn`) before dispatching and skip unhealthy agents.

For alias configuration schema and examples see [`docs/USAGE.md`](docs/USAGE.md).

---

## Persistent workers

Spawn long-lived named workers via `acp_spawn`. Workers persist across task completions and are managed via the unified tools:

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
│  acp_spawn ───┐                                      │
│  acp_status ──┤                                      │
│  acp_msg ─────┤──► AliasResolver ──► Coordinator ──┐ │
│  acp_dag ─────┤                       │            │ │
│  acp_fanout ──┤                       ▼            │ │
│  acp_task ────┤              AcpCircuitBreaker     │ │
│  acp_governance┘                       │            │ │
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
| **Tool consolidation plan** (33 → 7 ACP core multiplexed tools; 9 total with hooks policy) | [`../pi-plugins/flow/intentions/pi-acp-agents/tool-consolidation.md`](https://github.com/buihongduc132/pi-plugins/blob/main/flow/intentions/pi-acp-agents/tool-consolidation.md) |
| **ACP vs teams gap analysis** | [`../pi-plugins/flow/findings/acp-vs-teams-analysis.md`](https://github.com/buihongduc132/pi-plugins/blob/main/flow/findings/acp-vs-teams-analysis.md) |
| **DAG delegation design** | [`openspec/changes/archive/2026-06-20-acp-dag-delegation/`](openspec/changes/archive/2026-06-20-acp-dag-delegation/) |
| **DAG widget design** | [`openspec/changes/archive/2026-06-22-acp-dag-widget/`](openspec/changes/archive/2026-06-22-acp-dag-widget/) |
| **Session-scoped runtime stores** | [`openspec/changes/archive/2026-06-19-scope-runtime-stores-per-session/`](openspec/changes/archive/2026-06-19-scope-runtime-stores-per-session/) |
| **Branch consolidation record** (this release) | [`docs/branch-consolidation-2026-06-22.md`](docs/branch-consolidation-2026-06-22.md) |
| **OpenSpec changes** | [`openspec/changes/`](openspec/changes/) |
| **Specs (canonical)** | [`openspec/specs/`](openspec/specs/) |

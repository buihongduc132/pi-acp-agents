# @walodayeet/pi-acp-agents

> **Multi-agent orchestration for pi** — Spawn, control, and coordinate ACP-compatible agents (Gemini CLI, Claude, Codex, etc.) as first-class tools within the pi coding agent.

[![npm version](https://img.shields.io/npm/v/@walodayeet/pi-acp-agents.svg)](https://www.npmjs.com/package/@walodayeet/pi-acp-agents)
[![CI](https://github.com/buihongduc132/pi-acp-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/buihongduc132/pi-acp-agents/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@walodayeet/pi-acp-agents.svg)](https://github.com/buihongduc132/pi-acp-agents/blob/main/LICENSE)

---

## Purpose

`pi-acp-agents` bridges the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) ecosystem with the [pi coding agent](https://pi.dev). It lets pi invoke external ACP-compatible agents as tools — enabling **multi-model collaboration**, **cross-agent delegation**, and **response comparison** from a single orchestrator.

### Why this exists

| Problem                                      | Solution                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| pi can only use one LLM at a time            | ACP agents let pi call Gemini, Claude, or any ACP agent on demand                    |
| No way to compare model outputs side-by-side | `acp_compare` runs the same prompt across agents and returns a structured comparison |
| Subprocess spawning is fragile               | Built-in circuit breaker, health monitoring, and busy-session mutex                  |
| Each agent tool integration is bespoke       | Adapter pattern: one config format for any ACP agent                                 |
| Can't see what's running or cancel it        | TUI widget shows live progress per agent; ESC cancels immediately                    |
| Need multiple agents on same task            | `acp_delegate_parallel` runs N agents simultaneously with independent tracking       |

### What it does

- Registers 34+ pi tools for ACP agent management
- Manages session lifecycle (create, load, set model/mode, cancel, dispose)
- Provides multi-agent coordination (delegate, delegate_parallel, broadcast, compare)
- Resilient by default: circuit breaker, stall timeout, health polling
- TUI widget with live per-delegation progress (agent name, phase, elapsed, text preview)
- ESC/abort support: cancel running delegations immediately via pi's AbortSignal
- Parallel delegation: Promise.all to N agents with independent progress tracking

---

## Install

```bash
pi install npm:@walodayeet/pi-acp-agents
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@walodayeet/pi-acp-agents"]
}
```

## Quick Start

1. Ensure an ACP agent is installed (e.g., Gemini CLI):

   ```bash
   gemini --version
   gemini  # first run to authenticate
   ```

2. Configure (optional — defaults to gemini):

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

---

## Tools

### Session Management (Level 1)

Friendly session names are globally unique across ACP sessions, immutable once assigned, persisted in the runtime directory, and remain resolvable after reload for both live and archived sessions.

| Tool         | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `acp_prompt` | Send a prompt to an ACP agent, get the text response           |
| `acp_status` | Show configured agents, active sessions, circuit breaker state |

### Session Lifecycle (Level 2)

| Tool                    | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `acp_session_new`       | Create a new isolated session with an agent; optional immutable `session_name`, caller cannot choose fresh session IDs |
| `acp_session_load`      | Load/resume an existing session by ID or friendly name, including archived auto-closed sessions       |
| `acp_session_set_model` | Change the model for an active session by ID or friendly name                 |
| `acp_session_set_mode`  | Change the mode (thinking level) for an active session by ID or friendly name |
| `acp_cancel`            | Cancel an ongoing prompt by ID or friendly name                               |

### Multi-Agent Coordination (Level 3)

| Tool                      | Description                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `acp_delegate`            | Delegate a task (short-lived session, auto-disposed, ESC to cancel)  |
| `acp_delegate_parallel`   | Delegate to multiple agents simultaneously (Promise.all, per-agent progress) |
| `acp_broadcast`           | Send same prompt to multiple agents in parallel                      |
| `acp_compare`             | Get responses from multiple agents and compare them                  |

**Commands:** `/acp` — ACP root command with session, prompt, delegate, broadcast, compare, task, message, plan, runtime groups

**Compatibility aliases:** `/acp-doctor`, `/acp-config`

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    pi agent                      │
│                                                  │
│  acp_prompt ──┐                                  │
│  acp_status ──┤                                  │
│  acp_session ─┤──► AgentCoordinator ──┐          │
│  acp_cancel ──┤                       │          │
│  acp_compare ─┘                       ▼          │
│                              AcpCircuitBreaker   │
│                                       │          │
│                              ┌────────┴────────┐ │
│                              │  Adapter Factory │ │
│                              └────┬───────┬────┘ │
│                              GeminiAdapter  │      │
│                                    CustomAdapter  │
│                                       │          │
│                              AcpClient (stdio)    │
│                                       │          │
│                              HealthMonitor ◄──────┤
│                              SessionManager       │
└─────────────────────────────────────────────────┘
                                       │
                              ┌────────┴────────┐
                              │  ACP Agent (gemini│
                              │  --acp, claude,  │
                              │  codex, custom)  │
                              └─────────────────┘
```

### Patterns

| Pattern             | Implementation                                              |
| ------------------- | ----------------------------------------------------------- |
| **Adapter** (GoF)   | `AcpAgentAdapter` → `GeminiAcpAdapter` / `CustomAcpAdapter` |
| **Factory**         | `createAdapter()` — string dispatch                         |
| **Circuit Breaker** | Closed → Open → Half-Open with configurable thresholds      |
| **Health Monitor**  | Background polling with distinct 1-hour no-response and completed-idle auto-close    |
| **Coordinator**     | Multi-agent delegate/broadcast/compare                      |

---

## Resilience

| Feature         | Default           | Description                                                 |
| --------------- | ----------------- | ----------------------------------------------------------- |
| Circuit breaker | 3 failures → open | Auto-recovers after 60s in half-open state                  |
| Stall timeout   | 1 hour            | Per-operation timeout with SIGTERM→SIGKILL escalation       |
| Health polling  | 30s               | Background monitor enforces separate no-response and completed-idle timers |
| Busy mutex      | per-session       | Prevents concurrent prompts on the same session             |
| Process safety  | SIGTERM→SIGKILL   | Graceful process shutdown with escalation                   |
| EPIPE handling  | stdin/stdout      | Prevents crashes on broken pipes                            |
| Non-blocking    | all paths         | Errors return as tool error results, never unhandled throws |
| Abort support   | all delegate tools | ESC triggers `adapter.cancel()` + `dispose()` immediately via AbortSignal |
| Progress feedback | delegate tools  | `_onUpdate` + widget show phase (spawning→init→session→prompting→done), elapsed, text preview |
| Parallel delegation | `acp_delegate_parallel` | Promise.allSettled to N agents with per-agent widget rows and independent cleanup |

---

## Configuration

Config file: `~/.pi/acp-agents/config.json`

```json
{
  "agent_servers": {
    "gemini": {
      "command": "gemini",
      "args": ["--acp"],
      "default_model": "gemini-2.5-pro"
    },
    "custom": {
      "command": "/path/to/my-acp-agent",
      "args": ["--mode", "acp"]
    }
  },
  "defaultAgent": "gemini",
  "staleTimeoutMs": 3600000,
  "healthCheckIntervalMs": 30000,
  "circuitBreakerMaxFailures": 3,
  "circuitBreakerResetMs": 60000,
  "stallTimeoutMs": 3600000
}
```

### Global config

| Field                       | Default                 | Description                               |
| --------------------------- | ----------------------- | ----------------------------------------- |
| `agent_servers`             | `{ gemini: {...} }`     | Map of agent name → config                |
| `defaultAgent`              | `"gemini"`              | Agent used when not specified             |
| `staleTimeoutMs`            | `3600000` (1 hour)      | Auto-close threshold for each separate lifecycle policy: stalled-no-response and completed-idle |
| `healthCheckIntervalMs`     | `30000` (30s)           | Background health polling interval        |
| `circuitBreakerMaxFailures` | `3`                     | Consecutive failures before circuit opens |
| `circuitBreakerResetMs`     | `60000` (60s)           | Time before circuit half-opens            |
| `stallTimeoutMs`            | `3600000` (1 hour)      | Per-operation timeout                     |
| `logsDir`                   | `~/.pi/acp-agents/logs` | Log directory                             |

### Per-agent config

| Field          | Required | Description                   |
| -------------- | -------- | ----------------------------- |
| `command`      | **yes**  | Executable to spawn           |
| `args`         | no       | Arguments (e.g., `["--acp"]`) |
| `env`          | no       | Extra environment variables   |
| `cwd`          | no       | Working directory override    |
| `default_model` | no      | Default model ID              |

---

## Logs

Central logs: `~/.pi/acp-agents/logs/`

- `main.log` — general structured JSON log
- `session-{id}/trace.jsonl` — per-session ACP JSON-RPC traces

---

## Supported Agents

| Agent           | Status                    | Config                               |
| --------------- | ------------------------- | ------------------------------------ |
| **Gemini CLI**  | ✅ Built-in adapter       | `command: "gemini", args: ["--acp"]` |
| **Claude Code** | 🔜 Planned                | ACP mode pending upstream            |
| **Codex**       | 🔜 Planned                | ACP mode pending upstream            |
| **Custom**      | ✅ Via `CustomAcpAdapter` | Any command speaking ACP over stdio  |

---

## Roadmap

### v0.2.x — Current (Foundation)

- [x] ACP stdio JSON-RPC client
- [x] Gemini CLI adapter with auto-auth
- [x] Session lifecycle (new, load, set model/mode, cancel)
- [x] Circuit breaker + health monitor
- [x] Multi-agent: delegate, broadcast, compare
- [x] TUI widget for session status
- [x] 148 unit + integration tests
- [x] CI/CD pipeline with provenance publishing
- [x] **Live progress feedback** — widget shows phase, elapsed, text preview per delegation
- [x] **ESC/abort support** — cancel running delegations immediately
- [x] **Parallel delegation** (`acp_delegate_parallel`) — Promise.all for multiple agents
- [x] 380 tests, 31 test files

### v0.3.x — Streaming & Auth

- [ ] **Streaming responses** — forward `agent_message_chunk` events to pi in real-time
- [ ] **Tool use forwarding** — expose ACP agent tool calls back to pi's tool registry
- [ ] **OAuth/token auth** — support API key and OAuth flows per-agent
- [ ] **Config hot-reload** — watch config file, reload without restart
- [ ] **Retry with backoff** — exponential backoff for transient failures
- [ ] Custom adapter smoke tests

### v0.4.x — Persistence & Recovery

- [ ] **Session persistence** — save/restore sessions across pi restarts
- [ ] **Session sharing** — share ACP sessions between pi instances via file lock
- [x] **Checkpoint/resume** — archived runtime metadata reopens auto-closed ACP sessions by original session ID
- [ ] **Metrics export** — Prometheus-compatible metrics (session count, latency, error rate)

### v0.5.x — Advanced Orchestration

- [ ] **Agent routing** — automatic agent selection based on task type
- [ ] **Ensemble mode** — run same prompt across N agents, merge via configurable strategy (vote, rank, consensus)
- [ ] **Chain-of-agents** — pipe output of one agent as input to next
- [ ] **Cost tracking** — per-agent, per-session token usage and cost estimation
- [ ] **Agent health dashboard** — web UI for monitoring all connected agents

### v1.0.0 — Production

- [ ] **Stable API** — no breaking changes without major version bump
- [ ] **Full ACP spec compliance** — implement all optional ACP capabilities
- [ ] **Multi-platform support** — OpenClaw, Claude Code plugin, standalone MCP server
- [ ] **Comprehensive docs** — API reference, migration guides, examples

---

## Development

```bash
npm install
npm test              # run all tests
npm run test:ci       # run with coverage
npm run typecheck     # TypeScript validation
npm run publish:dry   # verify package contents before publish
```

### Release process

```bash
npm run release:patch    # 0.2.0 → 0.2.1
npm run release:minor    # 0.2.0 → 0.3.0
npm run release:beta     # 0.2.0 → 0.2.1-beta.0
git push --follow-tags   # triggers CI → auto-publish with provenance
```

---

## License

MIT © walodayeet

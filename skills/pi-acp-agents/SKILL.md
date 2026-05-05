# pi-acp-agents

ACP agent client for pi — spawn and control ACP-compatible agents from within pi.

## What it does

This pi extension registers tools that let the pi LLM communicate with external ACP (Agent Client Protocol) compatible agents like Gemini CLI, Claude, or any custom command that speaks ACP over stdio JSON-RPC.

## Tools

| Tool                    | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `acp_prompt`            | Send a prompt to an ACP agent, get the text response           |
| `acp_status`            | Show configured agents, active sessions, circuit breaker state |
| `acp_session_new`       | Create a new isolated session with an agent                    |
| `acp_session_load`      | Load an existing session by ID                                 |
| `acp_session_set_model` | Change the model for an active session                         |
| `acp_session_set_mode`  | Change the mode (thinking level) for an active session         |
| `acp_cancel`            | Cancel an ongoing prompt                                       |
| `acp_delegate`          | Delegate a task (short-lived session, auto-disposed)           |
| `acp_broadcast`         | Send same prompt to multiple agents in parallel                |
| `acp_compare`           | Get responses from multiple agents and compare them            |

## Configuration

Config file: `~/.pi/acp-agents/config.json`

```json
{
  "agents": {
    "gemini": {
      "command": "gemini",
      "args": ["--acp"],
      "defaultModel": "gemini-2.5-pro"
    }
  },
  "defaultAgent": "gemini"
}
```

### Fields

| Field                       | Default             | Description                               |
| --------------------------- | ------------------- | ----------------------------------------- |
| `agents`                    | `{ gemini: {...} }` | Map of agent name → config                |
| `defaultAgent`              | `"gemini"`          | Agent used when not specified             |
| `staleTimeoutMs`            | `900000` (15 min)   | Session staleness threshold               |
| `healthCheckIntervalMs`     | `30000` (30s)       | Background health polling interval        |
| `circuitBreakerMaxFailures` | `3`                 | Consecutive failures before circuit opens |
| `circuitBreakerResetMs`     | `60000` (60s)       | Time before circuit half-opens            |
| `stallTimeoutMs`            | `300000` (5 min)    | Per-operation timeout                     |

### Per-agent config

| Field          | Required | Description                   |
| -------------- | -------- | ----------------------------- |
| `command`      | **yes**  | Executable to spawn           |
| `args`         | no       | Arguments (e.g., `["--acp"]`) |
| `env`          | no       | Extra environment variables   |
| `cwd`          | no       | Working directory override    |
| `defaultModel` | no       | Default model ID              |

## Resilience

- **Circuit breaker**: Opens after N consecutive failures, auto-recovers after timeout
- **Stall timeout**: Prompts that receive no activity are auto-cancelled
- **Health polling**: Background monitor tracks `lastActivityAt` per session
- **Busy mutex**: Prevents concurrent prompts on same session
- **Process safeguards**: SIGTERM → SIGKILL escalation, EPIPE error handlers
- **Non-blocking**: All tool errors return as tool error results, never throw

## Architecture

```
Adapter pattern:
  AcpAgentAdapter (abstract base)
  ├── GeminiAcpAdapter  — gemini --acp defaults
  └── CustomAcpAdapter  — any user-defined ACP command

Client layer:
  AcpClient — wraps @agentclientprotocol/sdk ClientSideConnection

Resilience:
  AcpCircuitBreaker — wraps all tool execute calls
  HealthMonitor — background session health polling

Coordination:
  AgentCoordinator — multi-agent delegate/broadcast/compare
```

## Logs

Central logs: `~/.pi/acp-agents/logs/`

- `main.log` — general log
- `session-{id}/trace.jsonl` — per-session JSON-RPC traces

## Prerequisites

- Gemini CLI installed and authenticated: `gemini --version` + `gemini` (login)
- ACP TypeScript SDK: bundled as dependency

## References

- ACP Protocol: https://agentclientprotocol.com/protocol/overview
- ACP TypeScript SDK: `@agentclientprotocol/sdk`
- Gemini ACP docs: https://geminicli.com/docs/cli/acp-mode/

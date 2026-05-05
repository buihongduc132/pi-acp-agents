# @walodayeet/pi-acp-agents

> ACP agent client for pi — spawn and control ACP-compatible agents (Gemini CLI, Claude, etc.) from within pi.

[![npm version](https://img.shields.io/npm/v/@walodayeet/pi-acp-agents.svg)](https://www.npmjs.com/package/@walodayeet/pi-acp-agents)
[![license](https://img.shields.io/npm/l/@walodayeet/pi-acp-agents.svg)](https://github.com/buihongduc132/pi-acp-agents/blob/main/LICENSE)

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

1. Ensure Gemini CLI is installed and authenticated:

   ```bash
   gemini --version
   gemini  # first run to authenticate
   ```

2. Configure (optional — defaults to gemini):

   ```bash
   mkdir -p ~/.pi/acp-agents
   cat > ~/.pi/acp-agents/config.json << 'EOF'
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
   EOF
   ```

3. Use in pi:
   ```
   Use the acp_prompt tool to ask gemini "What is the capital of France?"
   ```

## Tools

| Tool                    | Description                          |
| ----------------------- | ------------------------------------ |
| `acp_prompt`            | Send a prompt to an ACP agent        |
| `acp_status`            | Check agent connection status        |
| `acp_session_new`       | Create a new agent session           |
| `acp_session_load`      | Load an existing session             |
| `acp_session_set_model` | Change session model                 |
| `acp_session_set_mode`  | Change session mode (thinking level) |
| `acp_cancel`            | Cancel ongoing prompt                |
| `acp_delegate`          | Delegate task (short-lived session)  |
| `acp_broadcast`         | Broadcast to multiple agents         |
| `acp_compare`           | Compare responses across agents      |

## Architecture

Uses the **Adapter pattern** with OOP:

- `AcpAgentAdapter` — abstract base for all ACP agents
- `GeminiAcpAdapter` — Gemini CLI specific defaults
- `CustomAcpAdapter` — any user-defined ACP command
- `AcpClient` — wraps `@agentclientprotocol/sdk` ClientSideConnection
- `AcpCircuitBreaker` — resilience wrapping for all calls
- `HealthMonitor` — background session health polling
- `AgentCoordinator` — multi-agent delegate/broadcast/compare

## Resilience

- Circuit breaker: 3 failures → open, auto-recover after 60s
- Stall timeout: configurable, default 5 min
- Health polling: 30s interval background check
- Busy mutex: prevents concurrent prompts on same session
- Non-blocking: errors are tool error results, never unhandled throws

## Configuration

Config file: `~/.pi/acp-agents/config.json`

```json
{
  "agents": {
    "gemini": {
      "command": "gemini",
      "args": ["--acp"],
      "defaultModel": "gemini-2.5-pro"
    },
    "custom": {
      "command": "/path/to/my-acp-agent",
      "args": ["--mode", "acp"]
    }
  },
  "defaultAgent": "gemini",
  "staleTimeoutMs": 900000,
  "healthCheckIntervalMs": 30000,
  "circuitBreakerMaxFailures": 3,
  "circuitBreakerResetMs": 60000,
  "stallTimeoutMs": 300000
}
```

### Fields

| Field                       | Default                 | Description                               |
| --------------------------- | ----------------------- | ----------------------------------------- |
| `agents`                    | `{ gemini: {...} }`     | Map of agent name → config                |
| `defaultAgent`              | `"gemini"`              | Agent used when not specified             |
| `staleTimeoutMs`            | `900000` (15 min)       | Session staleness threshold               |
| `healthCheckIntervalMs`     | `30000` (30s)           | Background health polling interval        |
| `circuitBreakerMaxFailures` | `3`                     | Consecutive failures before circuit opens |
| `circuitBreakerResetMs`     | `60000` (60s)           | Time before circuit half-opens            |
| `stallTimeoutMs`            | `300000` (5 min)        | Per-operation timeout                     |
| `logsDir`                   | `~/.pi/acp-agents/logs` | Log directory                             |

### Per-agent config

| Field          | Required | Description                   |
| -------------- | -------- | ----------------------------- |
| `command`      | **yes**  | Executable to spawn           |
| `args`         | no       | Arguments (e.g., `["--acp"]`) |
| `env`          | no       | Extra environment variables   |
| `cwd`          | no       | Working directory override    |
| `defaultModel` | no       | Default model ID              |

## Logs

Central logs: `~/.pi/acp-agents/logs/`

- `main.log` — general log
- `session-{id}/trace.jsonl` — per-session JSON-RPC traces

## Development

```bash
npm install
npm test
npm run test:ci      # with coverage
npm run typecheck
```

## License

MIT © walodayeet

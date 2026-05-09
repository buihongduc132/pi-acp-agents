# Codex ACP — OpenAI Codex via Agent Client Protocol

## What

`codex-acp` is a third-party ACP bridge ([cola-io/codex-acp](https://github.com/cola-io/codex-acp)) that wraps the OpenAI Codex runtime with the Agent Client Protocol. It speaks ACP over stdio — no special handling needed.

## Prerequisites

### 1. Install codex-acp

Built from source (Rust):

```bash
git clone https://github.com/cola-io/codex-acp.git
cd codex-acp
cargo build --release
# Binary at target/release/codex-acp
```

Or download from [releases](https://github.com/cola-io/codex-acp/releases).

### 2. Install OpenAI Codex CLI

Follow [OpenAI Codex CLI docs](https://github.com/openai/codex). `codex-acp` depends on the Codex runtime.

### 3. Authenticate

Set your OpenAI API key:

```bash
export OPENAI_API_KEY="sk-..."
```

Or configure via `~/.codex/config.toml`.

## Configuration

Add to `~/.pi/acp-agents/config.json`:

```json
{
  "agent_servers": {
    "codex": {
      "command": "codex-acp",
      "args": [],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### With custom provider / base URL

```json
{
  "agent_servers": {
    "codex-custom": {
      "command": "codex-acp",
      "args": [],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_BASE_URL": "https://my-proxy.example.com/v1"
      }
    }
  }
}
```

## Usage

Once configured, use via the standard ACP tools:

```
acp_delegate — delegate task to codex agent
acp_prompt  — send prompt to codex session
acp_status  — check codex session health
```

### Supported ACP Features

| Feature | Status |
|---------|--------|
| Initialize + Auth | ✅ |
| New Session | ✅ |
| Prompt (streaming) | ✅ |
| Cancel | ✅ |
| Session modes (auto/read-only/full-access) | ✅ |
| Slash commands (/status, /compact, /review, /init) | ✅ |
| Filesystem MCP bridge | ✅ (built-in) |

### Slash Commands

`codex-acp` advertises these via ACP `available_commands_update`:

- `/status` — workspace, account, model, token usage
- `/compact` — compress conversation context
- `/review` — review current changes
- `/init` — create AGENTS.md

## Troubleshooting

### `codex-acp: command not found`

Install the binary and ensure it's on `PATH`. Or use absolute path:

```json
{ "command": "/usr/local/bin/codex-acp", "args": [] }
```

### Authentication errors

Ensure `OPENAI_API_KEY` is set in `env` or available in shell environment.

### Protocol mismatch

If codex-acp returns unexpected output, the ACP client will detect the mismatch and report a meaningful error. No manual intervention needed.

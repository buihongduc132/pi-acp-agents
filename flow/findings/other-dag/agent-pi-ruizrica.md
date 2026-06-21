# agent-pi (ruizrica)

- **URL**: https://github.com/ruizrica/agent-pi
- **Pattern**: Extension suite (43 extensions, 11 themes, 20+ skills)
- **Target**: pi subagents

## Mix script+LLM
Mostly YAML pipelines. Less "script mode" than other repos. Configuration + extension layer.

## Key features
- **6 operational modes**: NORMAL, PLAN, SPEC, PIPELINE, TEAM, CHAIN (toggle via Shift+Tab)
- **Multi-agent orchestration extensions**:
  - `agent-team` — dispatch-only, primary delegates to specialists via `dispatch_agent`
  - `agent-chain` — sequential pipeline, each step output feeds next via `$INPUT`
  - `pipeline-team` — 5-phase hybrid: UNDERSTAND → GATHER → PLAN → EXECUTE → REVIEW
  - `subagent-widget` — background subagent management with live status widgets
  - `toolkit-commands` — dynamic slash commands from markdown files
- **Security hardened** — pre-tool-hook guard blocks destructive commands, prompt injection detection, exfiltration prevention
- **Browser-based viewers** — interactive plan review, completion reports with rollback, spec approval with inline comments
- **11 themes**

## Borrow for ACP
- **`subagent-widget`** ← cross-ref acp-dag-widget. Live status widgets for background subagents.
- **`agent-chain` `$INPUT` pattern** ← ACP DAG uses `{step.output}` template. `$INPUT` simpler for linear chains.
- **5-phase pipeline-team (UNDERSTAND→GATHER→PLAN→EXECUTE→REVIEW)** ← ACP DAG has no canonical phase template. Could ship as predefined DAG.
- **Browser-based viewers with rollback** ← ACP has no review UI. Out of scope but interesting.

## Refs
- [ruizrica/agent-pi README](https://github.com/ruizrica/agent-pi)

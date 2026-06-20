# pi-flows (ChicK00o)

- **URL**: https://github.com/ChicK00o/pi-flows
- **Pattern**: YAML DAG + live TUI dashboard
- **Target**: pi subagents

## Mix script+LLM
YAML DAG authored by user OR **designed by LLM** (Flow Architect agent). LLM only inside agent nodes.

## Key features
- **Live TUI dashboard** — agents show cards in dashboard while main session stays interactive ← direct relevance to acp-dag-widget
- **Flow Architect** — built-in AI agent analyzes conversation context, designs complete flow DAG from agent catalog
- **Template variables** — `${{task}}`, `${{result.step-id.summary}}`, `${{input.name}}`, `${{config.key}}`
- **Model roles** — `@coding`, `@planning`, `@research`, `@compact` map to concrete models via `/roles`
- **Agents** = markdown + YAML frontmatter (config + system prompt). Scoped tools + filesystem access
- **Auto-routing** (`Ctrl+A`) — agents decide fork branches autonomously
- **Agent isolation** — each agent runs in isolated session

## Borrow for ACP
- **Live TUI cards** — exactly what acp-dag-widget wants. Each DAG step = card with live status.
- **Flow Architect pattern** — pre-canned DAG-from-context agent. Cross-ref G-G predefined teams.
- **Template var syntax `${{...}}`** vs ACP's `{step.output}` — both work, ACP simpler.
- **Agent definitions as markdown+frontmatter** — ACP uses `config.json agent_servers`. pi-flows' pattern is more shareable.

## Refs
- [pi-flows README](https://github.com/ChicK00o/pi-flows)

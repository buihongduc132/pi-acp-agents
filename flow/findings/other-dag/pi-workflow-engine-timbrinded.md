# pi-workflow-engine (timbrinded)

- **URL**: https://github.com/timbrinded/pi-workflow-engine/
- **Pattern**: Procedures-as-code, TypeBox typed handoffs
- **Target**: pi subagents

## Mix script+LLM
Write procedure as code. Each `agent()` runs in own in-memory pi session. Typed handoffs via TypeBox schemas instead of prose.

## Key features
- **Procedures not prompts** — turn agentic procedure into code (scope, fork, fan-out, validate handoffs, verify findings, synthesize ranked result)
- **Isolated subagents** — each `agent()` in own in-memory session via `createAgentSession` + `SessionManager.inMemory()`
- **Parallel cognition** — many focused agents at once, shared concurrency cap
- **Typed handoffs** — TypeBox schemas between stages
- **`dynamax` opt-in** — permission signal for host agent to author/run inline workflow
- **Inline workflow scripts** — passed as string to `workflow` tool
- Three surfaces: `/workflow [args]`, `/workflow:dynamax on|off|status` + `/workflow:inspector`, `workflow` tool

## Borrow for ACP
- **Typed handoffs via TypeBox** ← cross-ref Michaelliv finding. ACP DAG step output = raw text.
- **`dynamax` opt-in pattern** — permission signal before host agent can author workflows. ACP DAG has no such gate.
- **`/workflow:inspector`** — debug surface. ACP DAG has `acp_dag_status` only.
- **Three surfaces (cmd / mode-toggle / tool)** — ACP has tool only. No `/dag` command.

## Refs
- [timbrinded/pi-workflow-engine README](https://github.com/timbrinded/pi-workflow-engine/)

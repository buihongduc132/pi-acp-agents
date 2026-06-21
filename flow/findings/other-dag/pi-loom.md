# pi-loom (betaHi)

- **URL**: https://github.com/betaHi/pi-loom
- **Pattern**: **Script mode** — Claude Code dynamic-workflow ported to pi
- **Target**: pi subagents

## Mix script+LLM
**Closest to Archon inverted**: user/LLM writes orchestration script (`phase` + `parallel` + `agent(...)`), engine executes it. Control flow = code. LLM = each `agent()` call.

> "You write the plan as code: a script holds the loop, the branching, and the intermediate results, and each step is an LLM agent."

## Key features
- ONE tool `run_workflow` — pi's model decides to call it and writes the script itself
- `runWorkflowSource(scriptString, opts)` — takes script string (what LLM emits) vs imported fn
- Determinism checks (static)
- **Journaling** — same script+args → same agent-call sequence; re-run resumes from longest unchanged prefix
- Only final answer reaches main context; intermediate agent results stay in script variables

## Borrow for ACP
- **Journaling/resume** ← ACP DAG has `dag-resume` spec but no per-step journal cache. Strong pattern.
- **Script-string entry point** — ACP DAG takes declarative JSON only. Script-mode = more flexible (loops, branches in code). Out of scope for current acp-dag-widget but candidate for v2.
- **Final-answer-only-to-context** — keeps main context clean. ACP DAG already does this (returns dagId + status, not all step outputs).

## Refs
- [pi-loom README](https://github.com/betaHi/pi-loom)

# pi-agent-flywheel (burningportra)

- **URL**: https://github.com/burningportra/pi-agent-flywheel
- **Pattern**: Bead-based execution + multi-model planning + review gates
- **Target**: pi subagents
- **Based on**: Agentic Coding Flywheel

## Mix script+LLM
Multi-model planning (Gemini + GPT + Claude propose plans, synthesizes strongest path). Beads (br+bv tasks) executed by swarm. LLM does planning + review + memory.

## Key features
- **One-command flywheel** `/agent-flywheel` — discovery, planning, approval, execution, review, memory
- **Bead-based execution** — converts plans to `br` tasks with dependencies + acceptance criteria. Picks next safe bead instead of giant free-form prompt.
- **Multi-model planning** — multiple models propose plans, synthesizes strongest
- **Review gates** — auto-decides review passes, then fresh-eyes/polish/ergonomics/reality-check/bead-compliance flows
- **Compound memory** — durable learnings across runs
- **MCP Agent Mail** — parallel agents get identities, inboxes, file reservations, coordination threads (prevents silent overwrites)
- **`ntm`** — multi-agent panes, observable swarm execution

## Borrow for ACP
- **Multi-model planning (parallel planners, synthesize)** ← ACP DAG has single submitter. Could add `acp_dag_plan` that broadcasts to N planners and merges.
- **Bead dependency tracking + acceptance criteria** ← ACP DAG step has prompt + dependsOn only. No acceptance criteria field. Cross-ref G-D hooks (quality gate).
- **MCP Agent Mail (inboxes + file reservations)** ← prevents parallel workers clobbering. ACP workers share cwd. Big risk. Cross-ref G-F worktree (deferred).
- **Review gate flows** ← ACP DAG has no post-step review. Cross-ref G-D.
- **Compound memory across runs** ← ACP has no learning loop.

## Refs
- [burningportra/pi-agent-flywheel README](https://github.com/burningportra/pi-agent-flywheel)

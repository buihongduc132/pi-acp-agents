# pi-workflows (umutbasal)

- **URL**: https://github.com/umutbasal/pi-workflows
- **Pattern**: Script mode (JS/TS files in `.pi/workflows/`)
- **Target**: pi subagents

## Mix script+LLM
Author JS/TS workflow file with implicit globals. `agent(prompt)` spawns subagent. `pipeline(items, ...stages)` runs items through stages concurrently per stage, sequentially across stages.

## Key features
- **Discovery** — workflows found in `.pi/workflows/`, `.agents/workflows/`, `.pi-workflows/`, `~/.pi/agent/workflows/`
- `workflow` tool OR `/workflow` command
- `pipeline(items, ...stages)` — items concurrent per stage, stages sequential
- `parallel(thunks)` — array of zero-arg async fns concurrent
- `phase(name)` for progress tracking/UI
- `log(message)` TUI notification
- `args` JSON parsed input
- **Agent spawning** with optional JSON schema for structured output
- **Run tracking** — persistent status, steps, results in `.pi-workflows/.runs/`
- Validation: phases declared in `meta.phases` must be used; phase names match exactly; one phase per logical unit

## Borrow for ACP
- **Discovery from multiple dirs** ← ACP DAG is JSON-only via `acp_dag_submit`. Discovery of reusable DAG templates = G-G predefined teams.
- **Run tracking in `.runs/`** ← ACP DAG has `dag-index.json` + `<dagId>.json`. Same pattern.
- **`meta.phases` declaration + validation** — ACP DAG has no phase declaration requirement. Could enforce for clarity.
- **`pipeline(items, ...stages)`** — ACP DAG has no "items fan-out per stage" primitive. Would need to express via template vars.

## Refs
- [umutbasal/pi-workflows README](https://github.com/umutbasal/pi-workflows)

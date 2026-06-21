# pi-taskflow (heggria)

- **URL**: https://github.com/heggria/pi-taskflow
- **npm**: `pi-taskflow` v0.0.23 (2026-06-12)
- **Stars**: npm published, low
- **Pattern**: Declarative JSON DAG (not script)
- **Target**: pi subagents (NOT ACP)

## Mix script+LLM
Pure DAG — graph IS data. No script. LLM only inside each `task` node. "Workflow flows. Taskflow is a graph."

## Key features (no sandbox focus)
- Static verification BEFORE run: cycles, dead ends, budget overflow, dangling refs
- Dynamic fan-out (`loop` over items, each generates runtime sub-flow that's validated before run)
- Gates / quality gates / human approvals / retries / spend ceiling
- Resumable phase-by-phase
- Saveable as one-word `/tf:` command
- Uses same shorthand as pi built-in `task`/`tasks`/`chain`

## Borrow for ACP
- **Static-verify-before-spend**: ACP DAG already has `DagValidator` (cycle, dangling, dup). Add budget-overflow + dead-end checks.
- **Runtime-generated sub-flow validation**: ACP DAG has template resolution but no runtime-generated sub-DAG. Could add `DagOptions.nestedDag` with same validator.
- **Saveable commands**: ACP DAG has no "save this DAG as a reusable preset". Cross-refs G-G predefined teams.

## Refs
- [pi-taskflow README](https://github.com/heggria/pi-taskflow)

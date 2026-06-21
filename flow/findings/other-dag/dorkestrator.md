# dorkestrator (sandalsoft)

- **URL**: https://github.com/sandalsoft/dorkestrator
- **Pattern**: Lifecycle engine + DAG executor, YAML pipelines
- **Target**: pi subagents
- **Built on**: oh-my-pi (swarm pipelines) + tallow (teams tool)

## Mix script+LLM
LLM generates task dependency graph from interview answers. Conductor topologically sorts into waves, dispatches subagents in parallel. Lifecycle = event-sourced state machine.

## Key features
- **Lifecycle stages**: init → interview → planning → review → executing → completed
- **Interview mode** — structured Q&A collects requirements
- **Plan mode** — LLM generates task DAG
- **Review mode** — approve/modify/reject
- **Orchestrate** — topological sort → waves → parallel subagents
- **Swarm** — YAML pipelines via `/swarm run <file.yaml>`
- **Execution modes**: `pipeline` (implicit seq + explicit `waits_for`), `parallel` (all concurrent unless constrained), `sequential` (strict order)
- **SharedContext** — key-value store with write-on-complete semantics. Step results namespaced as `step..output`
- **Conductor** class with `executeTask` callback, `maxConcurrency`

## Borrow for ACP
- **Lifecycle engine (interview→plan→review→execute)** ← ACP DAG jumps straight to execute. No interview/review phase.
- **Wave model** ← ACP DAG ALREADY has wave-based execution (`DagExecutor`). Confirms pattern is correct.
- **SharedContext with write-on-complete** ← ACP DAG step output captured after step finishes. Same pattern.
- **`waits_for` override** ← ACP DAG uses `dependsOn` only. No "run earlier than declared" override.
- **`maxConcurrency` per conductor** ← ACP DAG has no global concurrency cap. Per-wave only.

## Refs
- [sandalsoft/dorkestrator README](https://github.com/sandalsoft/dorkestrator)

## Why

pi-acp-agents has the building blocks for DAG-based delegation — `AcpTaskStore` with `blockedBy`/`blocks` edges and DFS cycle detection, `WorkerStore` for persistent identities, `AsyncExecutor` for background dispatch, `CircuitBreaker` for resilience — but these are internal modules not exposed as a DAG orchestration surface. The LLM must manually create tasks, set dependencies, assign agents, and poll for completion across N sequential tool calls.

Meanwhile, the pi ecosystem has 5 extensions that provide first-class DAG delegation — but **all target pi subagents** (internal child processes), not ACP agents (external CLI agents like Gemini, Codex):

| Extension | Approach | Target |
|-----------|----------|--------|
| `pi-taskflow` (heggria) | Declarative JSON DAG, static verification, dynamic fan-out, phase resume | pi subagents |
| `dorkestrator` (sandalsoft) | Topological sort → waves, YAML pipelines, shared context | pi subagents |
| `pi-multiagent` (Tiziano-AI) | Static DAG with `needs`/`after` gates, graph authority | pi subagents |
| `pi-tasks` (harms-haus) | Phased board with `blockers`, DFS validation, auto-advance | pi subagents |
| `pi-dynamic-workflows` (Michaelliv) | Model-generated JS with `parallel()`/`pipeline()` | pi subagents |

**None work with ACP agents.** ACP agents are external processes with ACP JSON-RPC transport, no shared filesystem, no context forking, and different lifecycle semantics. This change closes that gap.

## What Changes

- **New `DagStore`** — file-backed DAG definition + execution state persistence (separate from `AcpTaskStore` to avoid polluting the manual task namespace)
- **New `DagValidator`** — static validation before execution: cycle detection (DFS), dangling reference check, duplicate ID detection, agent availability check against configured agents
- **New `DagExecutor`** — topological sort → wave-based execution; steps within a wave dispatch in parallel via existing `AsyncExecutor`; output capture per step; template variable resolution (`{<step-id>.output}`, `{dag.args.*}`) injected into downstream prompts
- **New `TemplateResolver`** — resolves `{<step-id>.output}`, `{<step-id>.status}`, `{dag.args.<key>}` references in step prompts; handles truncation for large outputs
- **3 new pi tools** registered in `index.ts`:
  - `acp_dag_submit` — submit a complete DAG in one call → returns `dagId`
  - `acp_dag_status` — get full DAG execution state (all steps, statuses, results, wave progress)
  - `acp_dag_cancel` — cancel a running DAG (abort in-flight agents, mark remaining as cancelled)
- **Integration with existing infrastructure** — `DagExecutor` reuses `AgentCoordinator.delegate()` for step dispatch, `CircuitBreaker` for agent health checks, `AsyncExecutor` for parallel wave dispatch

## Capabilities

### New Capabilities
- `dag-submission`: Single-call DAG submission with static validation (cycle detection, dangling refs, duplicate IDs, agent availability). Returns `dagId` and starts background execution.
- `dag-execution`: Topological sort → wave-based parallel execution. Template variable resolution injects upstream step outputs into downstream prompts. Gate types: `needs` (success-gate) and `after` (completion-gate).
- `dag-monitoring`: Status polling returns full DAG state (all steps with status, results, dependency satisfaction, wave progress). Cancellation aborts in-flight agents and marks remaining steps.
- `dag-resume`: DAG state persisted to disk after each step transition. Resume from last checkpoint after pi restart.

### Modified Capabilities
<!-- No existing specs to modify — this is a net-new capability area -->

## Impact

- **Code**: New modules in `src/dag/` (DagStore, DagValidator, DagExecutor, TemplateResolver). New tool registrations in `src/index.ts`. New types in `src/config/types.ts`.
- **Runtime paths**: New `dag/` subdirectory under existing pi-acp-agents runtime dir (`~/.pi/acp-agents/dag/`) for DAG state files.
- **Dependencies**: No new npm dependencies — builds entirely on existing pi-acp-agents infrastructure.
- **APIs**: 3 new pi tools (`acp_dag_submit`, `acp_dag_status`, `acp_dag_cancel`). No changes to existing tools.
- **Context budget**: ~450 tokens of fixed overhead (3 tool definitions × ~150 tokens each).
- **Alignment with remote extensions**: Follows the same DAG patterns as pi-taskflow (declarative JSON, static verification, phase resume), dorkestrator (wave-based execution, shared context), and pi-multiagent (`needs`/`after` gate types). Key differentiator: targets ACP agents instead of pi subagents.

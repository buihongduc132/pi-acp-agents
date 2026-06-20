## Context

pi-acp-agents is a pi extension that orchestrates **external ACP-compatible agents** (Gemini CLI, Codex CLI, custom ACP agents) via the ACP JSON-RPC 2.0 protocol over stdio. It currently provides point-to-point delegation: `acp_prompt`, `acp_delegate`, `acp_broadcast`, `acp_compare`. Each call is a single-shot interaction.

The codebase already has building blocks for dependency-aware orchestration:

| Module | Location | What exists |
|--------|----------|-------------|
| `AcpTaskStore` | `src/management/task-store.ts` | Task records with `blockedBy`/`blocks` edges, `findDependencyPath()` (DFS), `isTaskBlocked()`, `claimNextAvailable()`, `createWithPriority()` |
| `WorkerStore` | `src/management/worker-store.ts` | Persistent worker identities, status tracking, task assignment |
| `AsyncExecutor` | `src/core/async-executor.ts` | Background delegation with state tracking (pending→running→completed/failed) |
| `AgentCoordinator` | `src/coordination/coordinator.ts` | `delegate()`, `broadcast()`, `compare()` with circuit breaker integration |
| `CircuitBreaker` | `src/core/circuit-breaker.ts` | 3-state (closed→open→half-open) per-agent health tracking |
| `HealthMonitor` | `src/core/health-monitor.ts` | Background polling, auto-close stale sessions |

The pi ecosystem has 5 extensions doing DAG delegation — all for pi subagents:

| Extension | Key patterns we align with |
|-----------|--------------------------|
| **pi-taskflow** | Declarative JSON DAG, static verification before execution, phase-by-phase resume, `{step.output}` template vars |
| **dorkestrator** | `buildExecutionWaves()` topological sort → parallel waves, `step.<id>.output` shared context, Conductor pattern |
| **pi-multiagent** | `needs` (success-gate) vs `after` (completion-gate) distinction, sink steps for output aggregation |
| **pi-tasks** | Strict status lifecycle, DFS cycle validation, recursive phase recomputation on advance |
| **pi-dynamic-workflows** | `parallel()`/`pipeline()` abstractions, phase-based progress snapshots, budget tracking |

**Key constraint**: ACP agents are external processes. No shared filesystem, no context forking, no skill injection. Step outputs must be captured as text and injected into downstream prompts via template variable resolution.

## Goals / Non-Goals

**Goals:**
- Submit a complete DAG of ACP agent tasks in a single tool call
- Static validation before execution (cycles, dangling refs, agent availability)
- Wave-based parallel execution aligned with dorkestrator's `buildExecutionWaves()` pattern
- Template variable resolution (`{<step>.output}`) aligned with pi-taskflow/dorkestrator
- Gate types (`needs`/`after`) aligned with pi-multiagent
- DAG state persisted to disk, resumable after pi restart (aligned with pi-taskflow phase resume)
- Minimal tool surface: 3 tools (`acp_dag_submit`, `acp_dag_status`, `acp_dag_cancel`)

**Non-Goals:**
- NOT a replacement for pi-taskflow/dorkestrator — those work for pi subagents
- NOT imperative scripting (model-generated code) — the DAG is declarative JSON
- NOT a full workflow engine (no conditional routing, no dynamic fan-out, no sub-flow composition) — that's the separate Workflow extension
- NOT reusing `AcpTaskStore` for DAG steps — separate `DagStore` to avoid polluting the manual task namespace
- NOT round-robin auto-assignment in Phase 1 (P2 feature)
- NOT budget ceiling enforcement in Phase 1 (P2 feature)

## Decisions

### D1: Separate `DagStore` vs reusing `AcpTaskStore`

**Decision**: Create a new `DagStore` in `src/dag/dag-store.ts`.

**Rationale**: `AcpTaskStore` manages manually-created tasks that the LLM creates/assigns/polls individually. DAG steps are auto-managed by the executor — they have different lifecycle (wave-based), different state model (pending→running→completed/failed/skipped/cancelled), and different query patterns (you never "claim" a DAG step). Mixing them would complicate both.

**Alignment**: pi-taskflow has its own task node model separate from any task board. dorkestrator has its own task definitions. Both keep DAG state separate from general task management.

**Alternative considered**: Reuse `AcpTaskStore` with a `dagId` tag on each task. Rejected because: (a) DAG steps need wave-level atomic state transitions, (b) `claimNextAvailable()` semantics don't apply to DAG steps, (c) clearing a DAG would leave orphan task records.

### D2: Wave-based execution (topological sort → parallel waves)

**Decision**: Use dorkestrator's wave model — topological sort groups steps into waves, each wave executes in parallel via `AsyncExecutor`, next wave starts only when all steps in the current wave complete.

**Rationale**: This is the simplest correct model for DAG execution. It naturally handles: (a) parallel dispatch of independent steps, (b) sequential ordering of dependent steps, (c) checkpoint boundaries (persist after each wave). pi-taskflow uses the same model (phase-by-phase). dorkestrator's `buildExecutionWaves()` is the reference implementation.

**Alternative considered**: Event-driven (step completes → immediately check if dependents are unblocked → dispatch). More efficient but harder to checkpoint and reason about. Waves give natural checkpoint boundaries.

### D3: Template variable resolution via string interpolation

**Decision**: Before dispatching a step, resolve `{<step-id>.output}`, `{<step-id>.status}`, `{dag.args.<key>}` in the step's prompt string via regex replacement.

**Rationale**: Simple, predictable, aligned with pi-taskflow (`{step.output}`) and dorkestrator (`step.<id>.output`). ACP agents accept text prompts — there's no structured input schema to worry about.

**Truncation**: If a step output exceeds a configurable token limit (default: 8000 chars), truncate with `\n\n[... output truncated, {N} chars omitted ...]` marker. This prevents downstream prompts from exceeding agent context windows.

**Alternative considered**: Structured context injection (JSON object alongside prompt). Rejected because ACP agents accept a single text message — there's no "context" channel.

### D4: Gate types — `needs` (success) vs `after` (completion)

**Decision**: Each step can declare `gate: "needs" | "after"`. Default is `needs`.

- `needs`: downstream step only executes if the dependency **succeeded** (status = `completed`)
- `after`: downstream step executes when the dependency is **done regardless of outcome** (status = `completed` or `failed`)

**Rationale**: Aligned with pi-multiagent's `needs`/`after` distinction. Most DAG systems only have success-gates. The `after` gate is valuable for review/audit steps that need to see failure evidence.

### D5: Failed step handling — failFast vs continue

**Decision**: DAG submission accepts `options.failFast: boolean` (default: `true`).

- `failFast: true` → a failed step marks all transitive dependents as `skipped`. DAG continues executing independent branches.
- `failFast: false` → a failed step is treated like `after` gate — dependents still execute (they receive the error message as the output).

**Rationale**: pi-taskflow aborts the entire workflow on failure. dorkestrator continues independent branches. We choose the middle ground: failFast skips dependents but doesn't abort the whole DAG. This matches how a developer would handle it — "if research fails, skip planning and coding, but the analysis branch can still complete."

### D6: File layout — `src/dag/` module

**Decision**: New `src/dag/` directory with 4 files:

```
src/dag/
├── dag-store.ts          ← DagStore: file-backed DAG state persistence
├── dag-validator.ts      ← DagValidator: cycle detection, dangling refs, agent availability
├── dag-executor.ts       ← DagExecutor: topological sort, wave dispatch, output capture
└── template-resolver.ts  ← TemplateResolver: variable interpolation, truncation
```

**Rationale**: Follows the existing pi-acp-agents module pattern (one class per file, file-backed stores in `src/management/`, coordination logic in `src/coordination/`). The DAG module sits between management (state) and coordination (dispatch).

### D7: Runtime directory structure

**Decision**: DAG state files under `~/.pi/acp-agents/dag/`:

```
~/.pi/acp-agents/dag/
├── <dagId>.json          ← one file per DAG: definition + execution state
└── dag-index.json        ← index of all DAGs with summary status
```

**Rationale**: Follows the existing pi-acp-agents pattern of file-per-entity (tasks.json, workers.json, mailboxes/, async-runs.json). One file per DAG keeps state isolated and makes cleanup trivial.

### D8: Tool parameter shape for `acp_dag_submit`

**Decision**:

```typescript
{
  tasks: Array<{
    id: string;           // unique step identifier
    agent: string;        // agent name (must be in agent_servers config)
    prompt: string;       // prompt text, may contain {<id>.output} template vars
    dependsOn?: string[]; // step IDs this step depends on (default: [])
    gate?: "needs" | "after"; // gate type for ALL dependencies (default: "needs")
  }>;
  args?: Record<string, string>; // workflow-level arguments for {dag.args.*}
  options?: {
    failFast?: boolean;   // default: true
    maxRetries?: number;  // default: 0
  };
}
```

**Rationale**: Minimal surface — tasks array is the only required field. `args` and `options` are optional. The shape is close to pi-taskflow's JSON nodes and dorkestrator's task definitions, making it familiar to users of those extensions.

## Risks / Trade-offs

**[R1] Large output injection exceeds agent context window** → Mitigation: configurable truncation limit (default 8000 chars). Future: token-count-aware truncation using tiktoken.

**[R2] Wave-level checkpoint granularity** — if a step in wave 3 fails, wave 1 and 2 results are already persisted but wave 3 must be retried entirely. → Mitigation: acceptable for Phase 1. Future: per-step checkpoint within a wave.

**[R3] Agent crash mid-wave** — an ACP agent process dies while executing a step. → Mitigation: `AsyncExecutor` already handles this (state → `failed` with error message). `CircuitBreaker` marks agent unhealthy. DAG executor checks circuit before dispatching next wave.

**[R4] Template variable collision** — a step ID that looks like a reserved key (e.g., `dag`). → Mitigation: validation rejects step IDs matching reserved prefixes (`dag`, `step`, `agent`).

**[R5] DAG state file grows large** — many steps with large outputs. → Mitigation: outputs stored inline in DAG JSON (simple). Future: spill large outputs to separate files, keep only references in DAG state.

**[R6] No worktree isolation** — multiple steps assigned to the same agent share the same ACP session context. → Mitigation: each step creates a short-lived session (via `delegate()`), so context doesn't leak between steps. This is inherent to ACP — no shared state between delegate calls.

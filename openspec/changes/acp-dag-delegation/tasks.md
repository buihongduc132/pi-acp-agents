## 1. Types & Config

- [ ] 1.1 Add DAG types to `src/config/types.ts`: `DagTaskDefinition`, `DagStepStatus`, `DagStatus`, `DagStepRecord`, `DagRecord`, `DagOptions`, `DagIndexEntry`
- [ ] 1.2 Add DAG config fields to `AcpConfig`: `dagStaleTimeoutMs` (default 3_600_000), `dagOutputTruncateChars` (default 8000)
- [ ] 1.3 Add runtime path for DAG directory in `src/management/runtime-paths.ts`: `dagDir`, `dagIndexFile`
- [ ] 1.4 Add `acp_dag_submit`, `acp_dag_status`, `acp_dag_cancel` to `ACP_TOOL_NAMES` and `DEFAULT_SETTINGS` in `src/settings/config.ts`

## 2. DagStore — File-backed DAG State Persistence

- [ ] 2.1 Create `src/dag/dag-store.ts` with `DagStore` class (include `safeMkdir(dagDir)` in constructor)
- [ ] 2.1a Implement `ensureDagDir()` — create `~/.pi/acp-agents/dag/` subdirectory if not exists
- [ ] 2.2 Implement `create(definition)` — generates `dagId`, initializes all steps as `pending`, writes `<dagId>.json`, updates `dag-index.json`
- [ ] 2.3 Implement `get(dagId)` — reads and returns a `DagRecord`
- [ ] 2.4 Implement `updateStep(dagId, stepId, mutate)` — atomic step state transition with file write
- [ ] 2.5 Implement `updateDagStatus(dagId, status)` — transitions DAG-level status
- [ ] 2.6 Implement `listAll()` — reads `dag-index.json` and returns summary list
- [ ] 2.7 Implement `findRunning()` — scans DAG files for DAGs in `running` state (for resume on restart)
- [ ] 2.8 Write unit tests for DagStore in `test/dag/dag-store.test.ts`

## 3. DagValidator — Static Validation Before Execution

- [ ] 3.1 Create `src/dag/dag-validator.ts` with `DagValidator` class
- [ ] 3.2 Implement `validate(tasks, agentNames)` — returns `{valid: boolean, errors: string[]}`
- [ ] 3.3 Implement cycle detection via DFS (aligned with `AcpTaskStore.findDependencyPath()` pattern)
- [ ] 3.4 Implement dangling reference detection — all `dependsOn` targets must exist in task list
- [ ] 3.5 Implement duplicate step ID detection
- [ ] 3.6 Implement agent availability check — all referenced agents must exist in `agent_servers` config
- [ ] 3.7 Implement reserved step ID rejection — reject IDs matching `dag`, `step`, `agent`
- [ ] 3.8 Write unit tests for DagValidator in `test/dag/dag-validator.test.ts` covering all 5 validation rules + valid DAG pass-through

## 4. TemplateResolver — Variable Interpolation & Truncation

- [ ] 4.1 Create `src/dag/template-resolver.ts` with `TemplateResolver` class
- [ ] 4.2 Implement `resolve(prompt, stepOutputs, stepStatuses, dagArgs)` — regex-based string interpolation
- [ ] 4.3 Support `{<step-id>.output}` resolution from completed step outputs
- [ ] 4.4 Support `{<step-id>.status}` resolution from step statuses
- [ ] 4.5 Support `{dag.args.<key>}` resolution from workflow-level arguments
- [ ] 4.6 Implement output truncation — if output exceeds configurable limit (default 8000 chars), truncate with `\n\n[... output truncated, N chars omitted ...]`
- [ ] 4.7 Implement missing reference detection — unresolved variables after resolution pass indicate a bug (log warning)
- [ ] 4.8 Write unit tests for TemplateResolver in `test/dag/template-resolver.test.ts`

## 5. DagExecutor — Wave-based Parallel Execution

- [ ] 5.1 Create `src/dag/dag-executor.ts` with `DagExecutor` class
- [ ] 5.2 Implement `topologicalSort(tasks)` — returns ordered array of waves (each wave = array of step IDs)
- [ ] 5.3 Implement `execute(dagId)` — main loop: for each wave, dispatch all steps in parallel via `coordinator.delegate()` (NOT AsyncExecutor — DagExecutor manages the wave loop directly), wait for all to complete, resolve template vars for next wave, repeat
- [ ] 5.4 Implement wave dispatch — each step in a wave dispatched via `coordinator.delegate(agent, resolvedPrompt, cwd)`; explicitly capture and store step output (text on success, error on failure) in `DagStepRecord` via `DagStore.updateStep()`
- [ ] 5.5 Implement gate evaluation — `needs` gate: downstream only if dep `completed`; `after` gate: downstream if dep in terminal state regardless of outcome
- [ ] 5.6 Implement failFast logic — on step failure with `failFast: true`, mark all transitive dependents as `skipped`; with `failFast: false`, treat failure output as the resolved value for dependents
- [ ] 5.7 Implement circuit breaker check — before dispatching a step, check agent health via `CircuitBreaker`; if open, fail the step immediately
- [ ] 5.8 Implement DAG completion detection — when all steps reach terminal state, transition DAG to `completed` or `failed`
- [ ] 5.9 Implement `cancel(dagId)` — abort in-flight agent sessions, mark pending steps as `cancelled`, transition DAG to `cancelled`
- [ ] 5.10 Implement resume logic — on startup, find running DAGs, recompute waves from persisted state, skip completed steps, resume from next uncompleted wave
- [ ] 5.11 Implement stale DAG detection — mark `running` DAGs with no transitions for `dagStaleTimeoutMs` as `stale`; exclude from auto-resume in `findRunning()`
- [ ] 5.12 Implement step retry logic — on failure, if `maxRetries > 0` and retries < max, reset step to `pending` and re-dispatch; track `retryCount` in `DagStepRecord`
- [ ] 5.13 Write unit tests for DagExecutor in `test/dag/dag-executor.test.ts` — cover: linear DAG, parallel waves, failFast skip, after gate, cancel, resume, stale detection, retry with backoff

## 6. Tool Registration — 3 New Pi Tools

- [ ] 6.1 Register `acp_dag_submit` tool in `index.ts` — accepts `{tasks, args?, options?}`, validates via `DagValidator`, creates via `DagStore.create()`, starts `DagExecutor.execute()` in background, returns `{dagId}`
- [ ] 6.2 Register `acp_dag_status` tool in `index.ts` — accepts optional `{dagId}`, returns full DAG state if dagId provided, or listing of all DAGs if omitted
- [ ] 6.3 Register `acp_dag_cancel` tool in `index.ts` — accepts `{dagId}`, calls `DagExecutor.cancel()`, returns summary `{completed, aborted, cancelled}`
- [ ] 6.4 Add tool parameter schemas using TypeBox:
  - `acp_dag_submit`: `tasks: Type.Array(Type.Object({id: Type.String(), agent: Type.String(), prompt: Type.String(), dependsOn: Type.Optional(Type.Array(Type.String())), gate: Type.Optional(Type.Union([Type.Literal("needs"), Type.Literal("after")]))}))`, `args: Type.Optional(Type.Record(Type.String(), Type.String()))`, `options: Type.Optional(Type.Object({failFast: Type.Optional(Type.Boolean()), maxRetries: Type.Optional(Type.Number())}))`
  - `acp_dag_status`: `dagId: Type.Optional(Type.String())`
  - `acp_dag_cancel`: `dagId: Type.String()`

## 7. Integration & Wiring

- [ ] 7.1 Wire `DagExecutor` constructor with existing `AgentCoordinator`, `AsyncExecutor`, and `CircuitBreaker` instances from `index.ts`
- [ ] 7.2 Initialize `DagStore` with runtime directory path from `runtime-paths.ts`
- [ ] 7.3 Add resume-on-startup hook in extension `index.ts` — call `DagExecutor.resumeAll()` on extension load
- [ ] 7.4 Wire DAG step events to existing `AcpEventLog` — log `dag-step` events for each step lifecycle transition

## 8. Smoke Test

- [ ] 8.1 Create a test DAG definition (2-step linear: research → code) and verify end-to-end execution via `acp_dag_submit` + `acp_dag_status`
- [ ] 8.2 Verify template variable resolution — step 2 prompt contains `{step1.output}` and receives actual output
- [ ] 8.3 Verify cancellation — submit a 3-step DAG, cancel after step 1 completes, verify remaining steps are cancelled
- [ ] 8.4 Verify validation rejection — submit a DAG with a cycle, verify error response
- [ ] 8.5 Verify parallel wave execution — 3-wave DAG with steps "a" → ["b","c"] → "d"
- [ ] 8.6 Verify failFast — step "a" fails, dependents "b","c" are skipped, independent branch "d" completes
- [ ] 8.7 Verify after-gate — step "a" fails, step "b" with gate:"after" still executes
- [ ] 8.8 Verify DAG listing — submit 2 DAGs, call acp_dag_status without dagId, verify list
- [ ] 8.9 Verify output truncation — step with >8000 char output, downstream step receives truncated version
- [ ] 8.10 Verify resume after simulated restart — complete wave 1, delete in-memory state, reload from disk, verify wave 2 executes

## 9. Documentation

- [ ] 9.1 Update project documentation (README or AGENTS.md) with: DAG tool descriptions, submission JSON shape, template variable syntax, gate type semantics, config options (`dagStaleTimeoutMs`, `dagOutputTruncateChars`), and deferred plans reference

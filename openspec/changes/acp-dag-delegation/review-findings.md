# ACP DAG Delegation — Task List Review

**Reviewer**: @impl-reviewer  
**Date**: 2026-06-12  
**Scope**: tasks.md against proposal.md, design.md, and all 4 spec files

---

## Summary

The task list is well-structured with correct dependency ordering. However, there are **4 missing tasks** (severity: HIGH), **2 tasks that should be split** (severity: MEDIUM), and several gaps in smoke test coverage. The most critical omission is the **stale DAG detection** mechanism required by the dag-resume spec, and the **tool settings registration** needed for the 3 new tools to be enable/disable-configurable.

---

## Findings

### F1: Missing — Stale DAG detection [HIGH]

**Spec requirement**: dag-resume spec requires marking DAGs as `stale` after configurable timeout (default 1 hour) with no step transitions. Stale DAGs must NOT auto-resume.

**Current tasks**: Task 5.10 covers resume logic but has no subtask for stale detection. There is no timer/interval that checks for inactivity.

**Recommendation**: Add task `5.12`: Implement stale DAG detection — periodic check (or lazy check on resume) that marks `running` DAGs with no transitions for `dagStaleTimeoutMs` as `stale`. Ensure `findRunning()` in DagStore excludes `stale` DAGs from auto-resume.

---

### F2: Missing — Tool settings registration [HIGH]

**Codebase pattern**: All existing tools are registered in `ACP_TOOL_NAMES` array in `src/settings/config.ts` (line 17-52). The `isToolEnabled()` function checks this list. New tools not in this list cannot be toggled on/off.

**Current tasks**: No task adds `acp_dag_submit`, `acp_dag_status`, `acp_dag_cancel` to `ACP_TOOL_NAMES` or `DEFAULT_SETTINGS`.

**Recommendation**: Add task `1.4`: Add `acp_dag_submit`, `acp_dag_status`, `acp_dag_cancel` to `ACP_TOOL_NAMES` array and `DEFAULT_SETTINGS` in `src/settings/config.ts`.

---

### F3: Missing — maxRetries implementation [HIGH]

**Spec requirement**: dag-submission spec defines `options.maxRetries` (default 0). When > 0, a failed step should be retried up to N times before being marked as failed.

**Current tasks**: Task 5.6 covers failFast but no task implements retry logic. The `maxRetries` option is accepted in the submission schema (task 6.1) but never acted upon.

**Recommendation**: Add task `5.12`: Implement step retry logic — on step failure, if `maxRetries > 0` and retry count < max, re-queue the step (reset to `pending`) instead of marking as `failed`. Track retry count in `DagStepRecord`.

---

### F4: Missing — Documentation / AGENTS.md update [MEDIUM]

**Current tasks**: No task for updating project documentation.

**Recommendation**: Add task `9.1`: Update AGENTS.md (or project README) with:
- Description of the 3 new DAG tools
- DAG submission JSON shape
- Template variable syntax
- Gate type semantics
- Configuration options (`dagStaleTimeoutMs`, `dagOutputTruncateChars`)

---

### F5: Task 5 (DagExecutor) is too large [MEDIUM]

**Current**: 11 subtasks covering topological sort, wave dispatch, gate evaluation, failFast, circuit breaker, completion detection, cancellation, resume, and tests.

**Recommendation**: Split into:
- **Task 5A** (Core execution): 5.1-5.5, 5.8 — topological sort, wave dispatch, gate evaluation, completion detection
- **Task 5B** (Resilience): 5.6, 5.7, 5.9, 5.10, 5.11 — failFast, circuit breaker, cancel, resume, tests

This allows parallel implementation and clearer review boundaries.

---

### F6: DAG directory creation not explicit [LOW]

**Observation**: Task 1.3 adds `dagDir` and `dagIndexFile` to runtime paths. But the existing `runtime-paths.ts` pattern uses `ensureRuntimeDir()` which calls `safeMkdir()` on the root dir. The DAG directory is a **subdirectory** (`~/.pi/acp-agents/dag/`) — separate from the main runtime dir.

**Recommendation**: Add explicit `safeMkdir(dagDir)` call in DagStore constructor, or add a `ensureDagDir()` function. Add as subtask of 2.1.

---

### F7: Output capture not an explicit task [LOW]

**Spec requirement**: dag-execution spec requires capturing text output on success and error message on failure, storing in DAG state.

**Current tasks**: Implicitly handled in 5.4 (wave dispatch via coordinator.delegate()) but not called out as a distinct concern.

**Recommendation**: Add subtask `5.4a`: Explicitly capture and store step output (text on success, error message on failure) in DagStepRecord via DagStore.updateStep().

---

### F8: Non-existent DAG error handling not explicit [LOW]

**Spec requirement**: dag-monitoring spec requires `acp_dag_status` to return `DAG "<dagId>" not found` for unknown IDs, and `acp_dag_cancel` to return error for already-completed DAGs.

**Current tasks**: These are edge cases within 6.2 and 6.3 but not called out.

**Recommendation**: Add explicit subtasks or ensure test coverage in 6.2/6.3 for these error paths.

---

### F9: TypeBox schema detail insufficient [LOW]

**Observation**: Task 6.4 says "Add tool parameter schemas using TypeBox" but doesn't specify the nested schema shape. The existing codebase uses deeply nested TypeBox schemas (e.g., `Type.Array(Type.String())` for arrays, `Type.Optional()` wrappers).

**Recommendation**: Expand task 6.4 to explicitly define:
- `acp_dag_submit`: `tasks: Type.Array(Type.Object({id, agent, prompt, dependsOn?, gate?}))`, `args?: Type.Optional(Type.Record(Type.String(), Type.String()))`, `options?: Type.Optional(Type.Object({failFast?, maxRetries?}))`
- `acp_dag_status`: `dagId?: Type.Optional(Type.String())`
- `acp_dag_cancel`: `dagId: Type.String()`

---

## Requirement → Task Coverage Matrix

### dag-submission spec

| Requirement | Task(s) | Status |
|---|---|---|
| Single tool call submission | 6.1 | ✅ Covered |
| Returns dagId immediately | 6.1 | ✅ Covered |
| Background execution start | 6.1 + 5.3 | ✅ Covered |
| Cycle detection (DFS) | 3.3 | ✅ Covered |
| Dangling reference detection | 3.4 | ✅ Covered |
| Duplicate step ID detection | 3.5 | ✅ Covered |
| Agent availability check | 3.6 | ✅ Covered |
| Reserved step ID rejection | 3.7 | ✅ Covered |
| failFast option | 5.6 | ✅ Covered |
| maxRetries option | — | ❌ **NOT COVERED** (F3) |
| Gate type: needs | 5.5 | ✅ Covered |
| Gate type: after | 5.5 | ✅ Covered |
| Workflow-level args | 4.5 | ✅ Covered |

### dag-execution spec

| Requirement | Task(s) | Status |
|---|---|---|
| Wave-based parallel execution | 5.2, 5.3 | ✅ Covered |
| Steps in wave via AsyncExecutor | 5.3 | ✅ Covered |
| Template: {step.output} | 4.3 | ✅ Covered |
| Template: {step.status} | 4.4 | ✅ Covered |
| Template: {dag.args.key} | 4.5 | ✅ Covered |
| Output truncation | 4.6 | ✅ Covered |
| Step dispatch via coordinator.delegate() | 5.4 | ✅ Covered |
| Circuit breaker check before dispatch | 5.7 | ✅ Covered |
| Output capture per step | 5.4 (implicit) | ⚠️ Not explicit (F7) |
| DAG state transitions | 5.8 | ✅ Covered |
| Step skipped on failFast | 5.6 | ✅ Covered |

### dag-monitoring spec

| Requirement | Task(s) | Status |
|---|---|---|
| Full DAG status query | 6.2 | ✅ Covered |
| Non-existent DAG error | 6.2 (implicit) | ⚠️ Not explicit (F8) |
| DAG cancellation | 5.9, 6.3 | ✅ Covered |
| Cancel completed DAG error | 5.9 (implicit) | ⚠️ Not explicit (F8) |
| Cancel best-effort | 5.9 | ✅ Covered |
| DAG listing (no dagId) | 6.2 | ✅ Covered |
| Empty list when no DAGs | 6.2 (implicit) | ⚠️ Minor |
| Event logging (dag-step) | 7.4 | ✅ Covered |

### dag-resume spec

| Requirement | Task(s) | Status |
|---|---|---|
| Persist after step transition | 2.4 | ✅ Covered |
| Persist after wave completion | 2.4 (covers all transitions) | ✅ Covered |
| Resume from last checkpoint | 5.10 | ✅ Covered |
| Skip completed steps on resume | 5.10 | ✅ Covered |
| Mark interrupted step as pending | 5.10 | ✅ Covered |
| DAG index updated on state changes | 2.2, 2.6 | ✅ Covered |
| Stale DAG detection (1hr timeout) | — | ❌ **NOT COVERED** (F1) |
| Stale DAG no auto-resume | — | ❌ **NOT COVERED** (F1) |

### Cross-cutting concerns

| Requirement | Task(s) | Status |
|---|---|---|
| Tool settings registration | — | ❌ **NOT COVERED** (F2) |
| TypeBox schema detail | 6.4 (vague) | ⚠️ Insufficient (F9) |
| DAG directory creation | 1.3 (implicit) | ⚠️ Not explicit (F6) |
| Documentation update | — | ❌ **NOT COVERED** (F4) |
| Circular dependency avoidance | — | ✅ No risk (src/dag/ is leaf module) |
| Multi-agent coordination | 5.4 (uses coordinator.delegate per-step) | ✅ Implicitly covered |

---

## Smoke Test Gap Analysis

| Scenario | Current | Status |
|---|---|---|
| 2-step linear execution | 8.1 | ✅ |
| Template variable resolution | 8.2 | ✅ |
| Cancellation | 8.3 | ✅ |
| Validation rejection (cycle) | 8.4 | ✅ |
| Parallel waves (3-wave DAG) | — | ❌ Missing |
| failFast skip behavior | — | ❌ Missing |
| after-gate proceeds on failure | — | ❌ Missing |
| DAG listing (no dagId) | — | ❌ Missing |
| Resume after simulated restart | — | ❌ Missing |
| Stale DAG detection | — | ❌ Missing |
| Output truncation | — | ❌ Missing |
| Non-existent DAG error | — | ❌ Missing |
| Reserved step ID rejection | — | ❌ Missing |

**Recommendation**: Add smoke tests 8.5-8.10 covering at minimum: parallel waves, failFast, after-gate, DAG listing, resume, and truncation.

---

## Task Ordering Assessment

The dependency chain is correct:
```
1 (Types) → 2 (Store) → 3 (Validator) → 4 (Resolver) → 5 (Executor) → 6 (Tools) → 7 (Wiring) → 8 (Smoke)
```

Tasks 3 and 4 are independent of each other and could be parallelized. No missing dependencies detected.

---

## Recommended Additions to tasks.md

```markdown
## 1. Types & Config (additions)
- [ ] 1.4 Add `acp_dag_submit`, `acp_dag_status`, `acp_dag_cancel` to `ACP_TOOL_NAMES` and `DEFAULT_SETTINGS` in `src/settings/config.ts`

## 5. DagExecutor (additions)
- [ ] 5.12 Implement stale DAG detection — mark `running` DAGs with no transitions for `dagStaleTimeoutMs` as `stale`; exclude from auto-resume
- [ ] 5.13 Implement step retry logic — on failure, if `maxRetries > 0` and retries < max, reset step to `pending` and re-dispatch

## 8. Smoke Test (additions)
- [ ] 8.5 Verify parallel wave execution — 3-wave DAG with steps "a" → ["b","c"] → "d"
- [ ] 8.6 Verify failFast — step "a" fails, dependents "b","c" are skipped, independent branch "d" completes
- [ ] 8.7 Verify after-gate — step "a" fails, step "b" with gate:"after" still executes
- [ ] 8.8 Verify DAG listing — submit 2 DAGs, call acp_dag_status without dagId, verify list
- [ ] 8.9 Verify output truncation — step with >8000 char output, downstream step receives truncated version

## 9. Documentation
- [ ] 9.1 Update project documentation with DAG tool descriptions, JSON schema, template syntax, and config options
```

---

## Circular Dependency Analysis

**Verdict: No risk.**

`src/dag/` imports from:
- `src/config/types.ts` (types only)
- `src/coordination/coordinator.ts` (AgentCoordinator)
- `src/core/circuit-breaker.ts` (AcpCircuitBreaker)
- `src/core/async-executor.ts` (AsyncExecutor — though DagExecutor may bypass this and use coordinator.delegate() directly)
- `src/management/event-log.ts` (AcpEventLog)
- `src/management/runtime-paths.ts` (paths)

None of these modules import from `src/dag/`. The dependency is strictly one-directional.

**Note**: Task 5.3 mentions dispatching via `AsyncExecutor.start()`, but the design doc (D2, 5.4) says dispatch via `coordinator.delegate()`. These are different patterns — `AsyncExecutor` wraps `coordinator.delegate()` with background Promise tracking. The DagExecutor should likely call `coordinator.delegate()` directly (since the executor itself manages the wave loop) rather than going through `AsyncExecutor`. This should be clarified in task 5.3/5.4.

---

## Multi-Agent Coordination

**Assessment: Adequately covered.**

Each DAG step specifies an `agent` field. `AgentCoordinator.delegate()` already handles dispatching to different agents (gemini, codex, custom) with per-agent adapter creation and disposal. The DAG executor simply calls `coordinator.delegate(step.agent, resolvedPrompt, cwd)` for each step — different steps can target different agents.

The validation step (3.6) checks that all referenced agents exist in `agent_servers` config. Agent aliases (fallback chains) are also supported via the coordinator's alias resolution.

**One gap**: No explicit mention of how `cwd` is handled for DAG steps. The design doesn't specify whether each step inherits a global `cwd` or can specify its own. Task 6.1's parameter shape doesn't include `cwd` per step. This should be clarified — recommend adding `cwd?: string` as an optional per-step field, or documenting that all steps share the extension's `ctx.cwd`.

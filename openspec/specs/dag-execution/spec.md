# dag-execution Specification

## Purpose
TBD - created by archiving change acp-dag-delegation. Update Purpose after archive.
## Requirements
### Requirement: Wave-based parallel execution
The system SHALL execute DAG steps using topological sort → wave-based execution. Steps within a wave (all dependencies satisfied) SHALL execute in parallel via `AsyncExecutor`. The next wave SHALL NOT start until all steps in the current wave reach a terminal state (completed, failed, or skipped).

#### Scenario: Execute a 3-wave DAG
- **WHEN** a DAG has waves [["a"], ["b", "c"], ["d"]] where "b" and "c" both depend on "a" and "d" depends on both "b" and "c"
- **THEN** the system executes "a" first, then "b" and "c" in parallel, then "d" — each wave waits for the previous wave to complete

#### Scenario: Steps within a wave dispatch via AsyncExecutor
- **WHEN** wave 2 contains steps "b" and "c"
- **THEN** both steps SHALL be dispatched via `AsyncExecutor.start()` concurrently, and the wave completes when both reach terminal state

### Requirement: Template variable resolution
Before dispatching each step, the system SHALL resolve template variables in the step's prompt string. Supported variables: `{<step-id>.output}` (text result of a completed step), `{<step-id>.status}` (status of a step), `{dag.args.<key>}` (workflow-level arguments). Resolution SHALL use regex-based string interpolation.

#### Scenario: Resolve upstream step output
- **WHEN** step "b" has prompt `"Implement based on {a.output}"` and step "a" completed with output `"Use JWT tokens"`
- **THEN** the dispatched prompt for step "b" SHALL be `"Implement based on Use JWT tokens"`

#### Scenario: Resolve workflow-level arguments
- **WHEN** the DAG was submitted with `args: {lang: "TypeScript"}` and a step prompt contains `"Write in {dag.args.lang}"`
- **THEN** the dispatched prompt SHALL be `"Write in TypeScript"`

#### Scenario: Truncate large outputs
- **WHEN** step "a" output is 15000 characters and the truncation limit is 8000 characters
- **THEN** the resolved `{a.output}` in downstream prompts SHALL be truncated to 8000 characters followed by `\n\n[... output truncated, 7000 chars omitted ...]`

#### Scenario: Resolve step status
- **WHEN** step "b" prompt contains `"Previous step status: {a.status}"` and step "a" completed
- **THEN** the dispatched prompt SHALL contain `"Previous step status: completed"`

### Requirement: Step dispatch via AgentCoordinator
Each step SHALL be dispatched via the existing `AgentCoordinator.delegate()` method, passing the resolved prompt and the assigned agent name. The system SHALL consult `CircuitBreaker` before dispatch — if an agent's circuit is open (unhealthy), the step SHALL fail with an error indicating the agent is unavailable.

#### Scenario: Successful step dispatch
- **WHEN** step "a" is assigned to agent "gemini" and the circuit breaker is closed (healthy)
- **THEN** the system calls `coordinator.delegate("gemini", resolvedPrompt, cwd)` and stores the result text as the step output

#### Scenario: Agent circuit breaker is open
- **WHEN** step "a" is assigned to agent "gemini" but the circuit breaker is open
- **THEN** the step SHALL fail with error: `Agent "gemini" is unavailable (circuit breaker open)`

### Requirement: Output capture per step
The system SHALL capture and store the text output of each completed step. The output SHALL be available for template variable resolution in downstream steps and for status queries.

#### Scenario: Capture step output on success
- **WHEN** step "a" completes with text response `"Research findings: ..."`
- **THEN** the DAG state SHALL store `output: "Research findings: ..."` for step "a"

#### Scenario: Capture error message on failure
- **WHEN** step "a" fails with error `"Agent timeout after 300000ms"`
- **THEN** the DAG state SHALL store `error: "Agent timeout after 300000ms"` for step "a" and the output field SHALL be null

### Requirement: DAG state transitions
The DAG SHALL follow the state machine: `pending` → `running` → `completed` / `failed` / `cancelled`. Steps SHALL follow: `pending` → `running` → `completed` / `failed` / `skipped` / `cancelled`.

#### Scenario: DAG transitions to completed when all steps succeed
- **WHEN** all steps in a DAG reach `completed` status
- **THEN** the DAG status SHALL transition to `completed`

#### Scenario: DAG transitions to failed when a step fails with failFast
- **WHEN** a step fails and all remaining steps are either completed, failed, or skipped
- **THEN** the DAG status SHALL transition to `failed`

#### Scenario: Step transitions to skipped when dependency fails (failFast)
- **WHEN** step "b" depends on step "a" with `gate: "needs"`, step "a" fails, and `failFast` is true
- **THEN** step "b" SHALL transition directly from `pending` to `skipped`


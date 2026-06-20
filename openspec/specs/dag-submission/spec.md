# dag-submission Specification

## Purpose
TBD - created by archiving change acp-dag-delegation. Update Purpose after archive.
## Requirements
### Requirement: DAG submission via single tool call
The system SHALL accept a complete DAG definition via `acp_dag_submit` containing a `tasks` array where each task has `id`, `agent`, `prompt`, and optional `dependsOn` and `gate` fields. The tool SHALL return a `dagId` immediately and begin execution in the background.

#### Scenario: Submit a simple linear DAG
- **WHEN** the LLM calls `acp_dag_submit` with `tasks: [{id: "a", agent: "gemini", prompt: "Research X"}, {id: "b", agent: "gemini", prompt: "Code based on {a.output}", dependsOn: ["a"]}]`
- **THEN** the system returns `{dagId: "<uuid>"}` and begins executing step "a" immediately while step "b" remains pending

#### Scenario: Submit a DAG with parallel branches
- **WHEN** the LLM calls `acp_dag_submit` with tasks "a" (no deps), "b" (depends on "a"), "c" (depends on "a"), "d" (depends on "b" and "c")
- **THEN** the system returns a `dagId` and execution proceeds in waves: wave 1 = ["a"], wave 2 = ["b", "c"] (parallel), wave 3 = ["d"]

#### Scenario: Submit with workflow-level arguments
- **WHEN** the LLM calls `acp_dag_submit` with `args: {topic: "authentication"}` and a step prompt containing `{dag.args.topic}`
- **THEN** the template resolver SHALL replace `{dag.args.topic}` with `"authentication"` before dispatching the step

### Requirement: Static validation before execution
The system SHALL validate the DAG definition before starting execution. Validation SHALL check: cycle detection via DFS, dangling reference detection (all `dependsOn` targets must exist), duplicate step ID detection, and agent availability (all referenced agents must exist in `agent_servers` config). If validation fails, the system SHALL reject the submission and return a detailed error listing all violations.

#### Scenario: Reject a DAG with a cycle
- **WHEN** the LLM submits a DAG where task "a" depends on "b" and task "b" depends on "a"
- **THEN** the system SHALL reject the submission with error: `DAG validation failed: cycle detected: a → b → a`

#### Scenario: Reject a DAG with dangling dependency
- **WHEN** the LLM submits a DAG where task "b" has `dependsOn: ["x"]` but no task with id "x" exists
- **THEN** the system SHALL reject with error: `DAG validation failed: dangling reference: task "b" depends on unknown step "x"`

#### Scenario: Reject a DAG with duplicate step IDs
- **WHEN** the LLM submits a DAG with two tasks having `id: "research"`
- **THEN** the system SHALL reject with error: `DAG validation failed: duplicate step ID: "research"`

#### Scenario: Reject a DAG referencing an unconfigured agent
- **WHEN** the LLM submits a DAG with `agent: "unknown-agent"` and no such agent exists in `agent_servers` config
- **THEN** the system SHALL reject with error: `DAG validation failed: unknown agent: "unknown-agent"`

#### Scenario: Reject reserved step IDs
- **WHEN** the LLM submits a DAG with a step `id: "dag"` or `id: "step"` or `id: "agent"`
- **THEN** the system SHALL reject with error: `DAG validation failed: reserved step ID: "dag"`

### Requirement: DAG options — failFast and maxRetries
The system SHALL accept optional `options.failFast` (boolean, default `true`) and `options.maxRetries` (number, default `0`) in the submission.

#### Scenario: failFast=true skips dependents of failed step
- **WHEN** a DAG is submitted with `failFast: true` and step "a" fails
- **THEN** all steps that transitively depend on "a" SHALL be marked as `skipped`, while independent branches continue executing

#### Scenario: failFast=false allows dependents to execute on failure
- **WHEN** a DAG is submitted with `failFast: false` and step "a" fails
- **THEN** steps depending on "a" SHALL still execute, receiving the error message as the resolved value of `{a.output}`

### Requirement: Gate types — needs and after
Each step SHALL support an optional `gate` field (`"needs"` or `"after"`, default `"needs"`) that controls how dependency outcomes affect execution.

#### Scenario: needs gate blocks on dependency failure
- **WHEN** step "b" depends on step "a" with `gate: "needs"` and step "a" fails
- **THEN** step "b" SHALL NOT execute (it is marked `skipped` if failFast=true, or receives error output if failFast=false)

#### Scenario: after gate proceeds regardless of dependency outcome
- **WHEN** step "b" depends on step "a" with `gate: "after"` and step "a" fails
- **THEN** step "b" SHALL execute regardless, receiving the error message as `{a.output}`


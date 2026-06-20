# dag-monitoring Specification

## Purpose
TBD - created by archiving change acp-dag-delegation. Update Purpose after archive.
## Requirements
### Requirement: DAG status query returns full state
The `acp_dag_status` tool SHALL return the complete execution state of a DAG, including: DAG ID, overall status, all steps with their individual statuses, outputs, errors, dependency satisfaction, and current wave information.

#### Scenario: Query status of a running DAG
- **WHEN** the LLM calls `acp_dag_status` with a `dagId` for a DAG currently executing wave 2 of 3
- **THEN** the response SHALL include: `dagId`, `status: "running"`, `currentWave: 2`, `totalWaves: 3`, and for each step: `id`, `agent`, `status`, `output` (if completed), `error` (if failed), `dependsOn`

#### Scenario: Query status of a completed DAG
- **WHEN** the LLM calls `acp_dag_status` for a DAG where all steps completed
- **THEN** the response SHALL include `status: "completed"` and each step SHALL have `status: "completed"` with its `output` field populated

#### Scenario: Query status of a non-existent DAG
- **WHEN** the LLM calls `acp_dag_status` with a `dagId` that does not exist
- **THEN** the system SHALL return an error: `DAG "<dagId>" not found`

### Requirement: DAG cancellation
The `acp_dag_cancel` tool SHALL cancel a running DAG. It SHALL abort in-flight agent sessions, mark all `pending` steps as `cancelled`, and return a summary of the cancellation.

#### Scenario: Cancel a running DAG
- **WHEN** the LLM calls `acp_dag_cancel` for a DAG with 2 completed steps, 1 running step, and 2 pending steps
- **THEN** the system SHALL abort the running step's agent session, mark the 2 pending steps as `cancelled`, transition the DAG to `cancelled`, and return a summary: `{completed: 2, aborted: 1, cancelled: 2}`

#### Scenario: Cancel an already-completed DAG
- **WHEN** the LLM calls `acp_dag_cancel` for a DAG with `status: "completed"`
- **THEN** the system SHALL return an error: `DAG "<dagId>" is already completed and cannot be cancelled`

#### Scenario: Cancel is best-effort for in-flight steps
- **WHEN** the LLM cancels a DAG and one step's agent session is already in the process of completing
- **THEN** the step MAY complete successfully if the agent finished before the cancel signal was processed — the system SHALL reflect the actual outcome in the step status

### Requirement: DAG listing
The system SHALL maintain a `dag-index.json` file that tracks all DAGs with summary status. This index SHALL be queryable via `acp_dag_status` when called without a `dagId`.

#### Scenario: List all DAGs
- **WHEN** the LLM calls `acp_dag_status` without a `dagId`
- **THEN** the response SHALL list all DAGs with: `dagId`, `status`, `totalSteps`, `completedSteps`, `failedSteps`, `createdAt`, `updatedAt`

#### Scenario: List when no DAGs exist
- **WHEN** the LLM calls `acp_dag_status` without a `dagId` and no DAGs have been submitted
- **THEN** the response SHALL return an empty list: `{dags: []}`

### Requirement: Event logging for DAG steps
The system SHALL log each step lifecycle event (start, complete, fail, skip, cancel) to the existing `AcpEventLog` with type `dag-step` and data including `dagId`, `stepId`, `agent`, `status`, and `durationMs`.

#### Scenario: Log step start event
- **WHEN** step "a" begins execution
- **THEN** an event SHALL be appended to the event log: `{type: "dag-step", data: {dagId, stepId: "a", agent: "gemini", status: "running", timestamp}}`

#### Scenario: Log step completion event
- **WHEN** step "a" completes successfully after 12 seconds
- **THEN** an event SHALL be appended: `{type: "dag-step", data: {dagId, stepId: "a", status: "completed", durationMs: 12000}}`


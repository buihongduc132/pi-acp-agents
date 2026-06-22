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


### Requirement: DAG state SHALL be present in the ACP TUI widget
The persistent ACP TUI widget (`src/acp-widget.ts`, registered in `index.ts:408`) SHALL include live DAG progress rows. When any DAG exists in `DagStore` (running, recently completed, or failed), the widget SHALL render a summary or per-DAG row.

#### Scenario: Widget renders running DAG
- **WHEN** a DAG is in `status: "running"` with 4/7 steps completed and 2 steps failed
- **THEN** the widget SHALL render one row showing: DAG ID, status icon, progress indicator (e.g., `[████░░░] 4/7`), current wave number, age (e.g., `2m ago`), and the first failed step ID with a failure marker.

#### Scenario: Widget renders no running DAGs
- **WHEN** no DAG is running but at least one completed/failed DAG exists within the recent history window
- **THEN** the widget SHALL render a collapsed one-line summary listing each recent DAG as `<dagId>:<status-icon>` (e.g., `a1b2c3:✓ d4e5f6:✕`).

#### Scenario: Widget has no DAGs at all
- **WHEN** `DagStore.listAll()` returns an empty list and no DAG has ever been submitted
- **THEN** the widget SHALL NOT render any DAG section. The widget layout SHALL be identical to the current pre-change rendering (sessions + circuit breaker + delegations + workers only).

### Requirement: DAG widget rows SHALL reflect live state transitions
The widget SHALL update DAG rows on each refresh tick (matching the existing `getWidgetState()` refresh cadence) by reading current state from `DagStore`.

#### Scenario: Step completes mid-refresh
- **WHEN** step 4 transitions from `running` to `completed` between two widget refresh ticks
- **THEN** the next tick SHALL show `5/7` progress and the failed-step marker SHALL disappear if step 4 was the failure, or remain if another step still failed.

#### Scenario: DAG transitions to completed
- **WHEN** the final step of a DAG completes
- **THEN** the next refresh tick SHALL show the DAG row with status icon `✓` and age since completion.

#### Scenario: DAG transitions to failed
- **WHEN** any step transitions to `failed` while the DAG is still `running`
- **THEN** the next refresh tick SHALL show the DAG row with status icon `✕` (warning/error) and surface the failed step ID.

### Requirement: DAG widget state SHALL be testable via `AcpWidgetState` fixtures
The `AcpWidgetState` type SHALL include an optional `dags?: AcpWidgetDag[]` field. Tests in `test/acp-widget-branches.test.ts` (and new test files if added) SHALL exercise render paths with and without DAG state, using the same `makeState()` fixture factory pattern used for sessions and workers today.

#### Scenario: Existing widget tests continue to pass
- **WHEN** `test/acp-widget-branches.test.ts` runs with existing `makeState()` fixtures that do not include `dags`
- **THEN** the widget SHALL render identically to pre-change behavior (no DAG section appears) and all existing assertions SHALL pass.

#### Scenario: New DAG fixture renders correctly
- **WHEN** a test calls `makeState({ dags: [ { dagId: "abc", status: "running", completed: 2, failed: 1, total: 5, currentWave: 2, totalWaves: 3 } ] })`
- **THEN** the rendered output SHALL contain the DAG row with progress `[███░░] 2/5`, wave `2/3`, and the failure marker.

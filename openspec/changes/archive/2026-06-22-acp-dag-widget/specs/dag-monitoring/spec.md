## ADDED Requirements

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

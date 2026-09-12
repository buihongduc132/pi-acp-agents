## MODIFIED Requirements

### Requirement: Output capture per step
The system SHALL capture and store the text output of each completed step. The output SHALL be cleaned of agent boot/context banner noise before storage (per the `output-capture` capability). The cleaned output SHALL be available for template variable resolution in downstream steps and for status queries.

#### Scenario: Capture step output on success
- **WHEN** step "a" completes with a cleaned text response `"Research findings: ..."`
- **THEN** the DAG state SHALL store `output: "Research findings: ..."` for step "a" with no boot banner prefix

#### Scenario: Capture error message on failure
- **WHEN** step "a" fails with error `"Agent timeout after 300000ms"`
- **THEN** the DAG state SHALL store `error: "Agent timeout after 300000ms"` for step "a" and the output field SHALL be null

#### Scenario: Downstream prompt receives clean output
- **WHEN** step "b" has prompt `"Based on {a.output}, write a summary"` and step "a" completed with a response that originally included a boot banner
- **THEN** the `{a.output}` template SHALL resolve to only the cleaned assistant response, with no boot banner or context list injected

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

## ADDED Requirements

### Requirement: Wave counter persistence
During wave-based execution, the executor SHALL persist `currentWave` and `totalWaves` to the `DagStore` so that status queries and the ACP widget reflect actual execution progress. `totalWaves` SHALL be set once when execution begins (the count of waves from `topologicalSort`). `currentWave` SHALL be updated at the start of each wave (1-indexed: wave 1 of N).

#### Scenario: totalWaves set at execution start
- **WHEN** a DAG with 3 waves (from `topologicalSort`) begins execution
- **THEN** the persisted `DagRecord.totalWaves` SHALL be set to 3

#### Scenario: currentWave updated per wave
- **WHEN** the executor begins dispatching wave 2 of 3
- **THEN** the persisted `DagRecord.currentWave` SHALL be updated to 2

#### Scenario: currentWave equals totalWaves at completion
- **WHEN** the final wave (wave 3 of 3) completes and all steps succeed
- **THEN** the persisted `DagRecord.currentWave` SHALL be 3 and `totalWaves` SHALL be 3

### Requirement: Step timestamp integrity
For each step, `startedAt` SHALL be written exactly once when the step transitions to `running`, and `completedAt` SHALL be written exactly once when the step transitions to a terminal state. No subsequent `updateStep` call SHALL overwrite either timestamp. The `durationMs` field SHALL equal `Date.parse(completedAt) - Date.parse(startedAt)` within a tolerance of 1000ms.

#### Scenario: startedAt preserved through completion
- **WHEN** a step transitions from `running` (at time T1) to `completed` (at time T2)
- **THEN** the persisted `startedAt` SHALL remain T1 (not be overwritten with T2 or any intermediate timestamp)

#### Scenario: durationMs consistent with timestamps
- **WHEN** a step completes with `startedAt=T1`, `completedAt=T2`, and `durationMs=D`
- **THEN** `D` SHALL equal `parse(T2) - parse(T1)` within a tolerance of 1000ms

#### Scenario: Resume does not corrupt timestamps
- **WHEN** a DAG is resumed after pi restart and a `running` step is reset to `pending` then re-dispatched
- **THEN** the re-dispatched step's `startedAt` SHALL reflect the resume time, not the original (pre-crash) time

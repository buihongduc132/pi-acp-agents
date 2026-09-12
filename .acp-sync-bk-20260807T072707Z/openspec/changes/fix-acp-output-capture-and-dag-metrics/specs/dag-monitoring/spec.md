## MODIFIED Requirements

### Requirement: DAG status query returns full state
The `acp_dag_status` tool SHALL return the complete execution state of a DAG, including: DAG ID, overall status, all steps with their individual statuses, outputs, errors, dependency satisfaction, and current wave information. The `currentWave` and `totalWaves` fields SHALL reflect the actual execution progress persisted by the executor (per the `dag-execution` wave-counter-persistence requirement), not the initialization-time zero values.

#### Scenario: Query status of a running DAG
- **WHEN** the LLM calls `acp_dag_status` with a `dagId` for a DAG currently executing wave 2 of 3
- **THEN** the response SHALL include: `dagId`, `status: "running"`, `currentWave: 2`, `totalWaves: 3`, and for each step: `id`, `agent`, `status`, `output` (if completed), `error` (if failed), `dependsOn`

#### Scenario: Query status of a completed DAG
- **WHEN** the LLM calls `acp_dag_status` for a DAG where all steps completed
- **THEN** the response SHALL include `status: "completed"`, `currentWave` and `totalWaves` SHALL both equal the total wave count, and each step SHALL have `status: "completed"` with its cleaned `output` field populated

#### Scenario: Query status of a non-existent DAG
- **WHEN** the LLM calls `acp_dag_status` with a `dagId` that does not exist
- **THEN** the system SHALL return an error: `DAG "<dagId>" not found`

#### Scenario: Wave counters reflect real progress not zeros
- **WHEN** the LLM calls `acp_dag_status` for a 3-wave DAG that has completed wave 1 and is executing wave 2
- **THEN** the response SHALL include `currentWave: 2` and `totalWaves: 3` (NOT `currentWave: 0, totalWaves: 0`)

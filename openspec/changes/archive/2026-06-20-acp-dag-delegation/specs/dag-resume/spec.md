## ADDED Requirements

### Requirement: DAG state persisted after each step transition
The system SHALL persist DAG state to disk (`~/.pi/acp-agents/dag/<dagId>.json`) after every step state transition (pending→running, running→completed, etc.). The persisted state SHALL include the full DAG definition, all step states, outputs, errors, and execution metadata.

#### Scenario: Persist state after step completion
- **WHEN** step "a" in DAG "abc123" completes
- **THEN** the file `~/.pi/acp-agents/dag/abc123.json` SHALL be updated with step "a" status `completed` and its output text

#### Scenario: Persist state after wave completion
- **WHEN** all steps in wave 2 of a DAG complete
- **THEN** the DAG state file SHALL reflect all wave 2 step outputs and the DAG SHALL be ready to resume from wave 3 if interrupted

### Requirement: Resume from last checkpoint after pi restart
When pi restarts and the DAG extension loads, the system SHALL scan `~/.pi/acp-agents/dag/` for DAGs in `running` state. For each such DAG, the system SHALL resume execution from the next uncompleted wave — steps already completed SHALL NOT be re-executed.

#### Scenario: Resume a DAG interrupted by pi restart
- **WHEN** pi restarts and finds a DAG with waves [["a"], ["b", "c"], ["d"]] where wave 1 completed and wave 2 was in progress (step "b" completed, step "c" was running)
- **THEN** the system SHALL mark step "c" as `pending` (needs retry), and resume execution from wave 2 — re-executing "c" and then proceeding to wave 3

#### Scenario: Skip already-completed steps on resume
- **WHEN** resuming a DAG where steps "a", "b" are `completed` and step "c" is `pending`
- **THEN** the system SHALL NOT re-execute "a" or "b" — it SHALL use their stored outputs for template resolution and only execute "c"

### Requirement: DAG index updated on state changes
The system SHALL update `dag-index.json` whenever a DAG is created, transitions state, or completes. The index SHALL contain summary information for each DAG.

#### Scenario: Index updated on DAG creation
- **WHEN** a new DAG is submitted
- **THEN** `dag-index.json` SHALL be updated with the new DAG's `dagId`, `status: "running"`, `totalSteps`, `createdAt`

#### Scenario: Index updated on DAG completion
- **WHEN** a DAG completes
- **THEN** `dag-index.json` SHALL reflect `status: "completed"` and `completedAt` timestamp

### Requirement: Stale DAG cleanup
The system SHALL mark DAGs in `running` state as `stale` if they have not had any step transition for a configurable timeout (default: 1 hour). Stale DAGs SHALL NOT auto-resume — they require explicit re-submission or manual intervention.

#### Scenario: Mark a DAG as stale after timeout
- **WHEN** a DAG has been in `running` state with no step transitions for 1 hour (and pi has not restarted)
- **THEN** the system SHALL mark the DAG as `stale` and log a warning event

#### Scenario: Stale DAG does not auto-resume
- **WHEN** pi restarts and finds a DAG in `stale` state
- **THEN** the system SHALL NOT resume the DAG — it SHALL leave it in `stale` state and report it in `acp_dag_status` listing with a note: `"DAG is stale, requires manual re-submission"`

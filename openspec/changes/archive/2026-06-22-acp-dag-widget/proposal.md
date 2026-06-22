## Why

DAG delegation shipped (PR #7) without any TUI surface. Users monitor running DAGs only via `acp_dag_status` JSON tool output — no live view of wave progress, step transitions, or failed steps in the persistent ACP widget. `src/acp-widget.ts` (379 lines) renders sessions, circuit breaker, delegations, and workers, but has **zero DAG references**. This closes the gap so DAGs get the same first-class live status that sessions and workers already have.

## What Changes

- **New `AcpWidgetDag` type** in `src/acp-widget.ts` — carries `dagId`, `status`, step counts (pending/running/completed/failed/cancelled), current wave, age, last transition, and the headlining failed step if any.
- **Extend `AcpWidgetState`** with `dags?: AcpWidgetDag[]` — populated from `DagStore.listAll()` (or `findRunning()`) in the existing `getWidgetState()` builder.
- **New DAG row render section** in the widget — shows running/recent DAGs with progress bar `[████░░░░] 4/7`, status icon, wave number, and age. Collapses to a one-line summary when no DAGs are running.
- **Wire `DagStore` into `index.ts`** — `getWidgetState()` already reads `SessionManager` + `WorkerStore`; add `dagStore.listAll()` (or a lightweight cached snapshot) to feed the new field.
- **Update `test/acp-widget-branches.test.ts`** and related widget tests to cover the new `dags` field + render paths.
- **No new tools, no API changes, no breaking changes.** The widget is additive UI state.

## Capabilities

### New Capabilities
<!-- None — DAG monitoring already has a spec (dag-monitoring); this change surfaces existing state to the TUI, it does not add new observable behavior beyond rendering. -->

### Modified Capabilities
- `dag-monitoring`: The widget now renders live DAG progress in the persistent ACP panel in addition to the existing `acp_dag_status` tool. No requirement semantics change — this extends the *visibility surface* for DAG state that the spec already requires to be queryable.

## Impact

- **Code**: `src/acp-widget.ts` (new types + render section), `index.ts` (wire `DagStore` into `getWidgetState()`), `test/acp-widget-*.test.ts` (new fixtures).
- **Dependencies**: Reads `DagStore` (`src/dag/dag-store.ts`) — already imported in `index.ts` for the DAG tools.
- **Performance**: `DagStore.listAll()` reads `dag-index.json` (already in-memory-cached per-session-store pattern). Widget refresh cadence is unchanged — no new polling.
- **No API/ABI changes**. Widget state shape gains an optional field — backwards compatible.

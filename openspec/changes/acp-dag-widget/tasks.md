## 1. Types

- [x] 1.1 Add `AcpWidgetDag` interface to `src/acp-widget.ts`: `{ dagId: string; status: DagStatus; total: number; completed: number; failed: number; cancelled: number; currentWave?: number; totalWaves?: number; createdAt: Date; updatedAt: Date; }`
- [x] 1.2 Extend `AcpWidgetState` (`src/acp-widget.ts`) with optional field `dags?: AcpWidgetDag[]`
- [x] 1.3 Add `DAG_STATUS_ICON` map in `src/acp-widget.ts` covering `pending | running | completed | failed | cancelled | stale` → `{ icon, color }` (reuse `success`/`warning`/`error`/`muted`/`dim`/`accent` palette; `running: { "●", "accent" }`, `completed: { "✓", "success" }`, `failed: { "✕", "error" }`, `cancelled: { "◻", "dim" }`, `pending: { "·", "muted" }`, `stale: { "◻", "warning" }`)
- [x] 1.4 Add `formatProgress(completed: number, failed: number, total: number): string` helper in `src/acp-widget.ts` returning e.g. `[██░░░] 2/5` (filled blocks = completed+failed, empty = remaining, width = min(total, 8))

## 2. Render

- [x] 2.1 Add `renderDagRow(dag: AcpWidgetDag): string` in `src/acp-widget.ts` — single-line format: `<icon> <dagId> <progress> wave <w>/<totalW> <age> [fail:<failed>]` (omit `wave …` if `totalWaves` absent; omit `[fail:N]` if `failed === 0`)
- [x] 2.2 Add `renderDagSummary(dags: AcpWidgetDag[]): string` — collapsed one-line `<dagId>:<icon>` pairs joined by spaces, capped at 5 entries (D2)
- [x] 2.3 Add `renderDagSection(state: AcpWidgetState): string` — returns `""` when `dags` absent/empty; returns `renderDagRow` per entry if any DAG `status === "running"`; otherwise returns `renderDagSummary` for recent completed/failed/cancelled DAGs (cap 5)
- [x] 2.4 Insert `renderDagSection(state)` call into the existing widget `render()` composition in `src/acp-widget.ts` — placed after the sessions section, before the workers section (D4 — decision: after sessions)
- [x] 2.5 Add a "DAGs" header line above the section only when rows are rendered (no header when section is empty)

## 3. State wiring

- [ ] 3.1 Import `DagStore` and `DagIndexEntry` into `index.ts` (if not already imported for the DAG tools — verify)
- [ ] 3.2 In `index.ts`'s `getWidgetState()` builder, after the existing `workers` population, add `dags: dagStore.listAll()` mapped to `AcpWidgetDag[]` (filter out `pending`; cap 5 by `updatedAt` desc)
- [ ] 3.3 Confirm `dagStore` instance is reachable from the widget state builder scope (same scope as `workerStore` already used) — if not, hoist the instance reference
- [ ] 3.4 Verify `DagIndexEntry` shape matches `AcpWidgetDag` mapping (status, totalSteps→total, completedSteps→completed, failedSteps→failed, createdAt, updatedAt). Document any field-name remapping as a comment

## 4. Tests

- [ ] 4.1 Update `test/acp-widget-branches.test.ts` `makeState()` fixture factory to accept an optional `dags` override (default `undefined`) — preserve all existing fixtures' behavior
- [ ] 4.2 Add test: "no dags field → renders identically to pre-change" (regression guard — existing assertions unchanged)
- [ ] 4.3 Add test: "running DAG with completed=2 failed=1 total=5 → renders `[██░░░] 2/5 wave 2/3 2m ago [fail:1]`"
- [ ] 4.4 Add test: "completed/failed DAGs only, no running → renders collapsed summary `<id>:✓ <id>:✕`"
- [ ] 4.5 Add test: "empty dags array `[]` → no DAG section renders (no header)"
- [ ] 4.6 Add test: ">5 DAGs → only 5 most-recent rendered"
- [ ] 4.7 Add test: `formatProgress` unit — 0/5, 5/5, 3/7 with 1 fail, edge case total=0 (return empty string)
- [ ] 4.8 Add integration test: submit a DAG via `dagStore.create()`, call `getWidgetState()`, assert `state.dags` is populated with correct counts

## 5. Smoke & docs

- [ ] 5.1 Run `pnpm test` (or repo equivalent) — all existing + new tests pass
- [ ] 5.2 Manual smoke: run pi with extension loaded, submit a 2-step DAG via `acp_dag_submit`, verify the widget shows a row during execution and a `✓` after completion
- [ ] 5.3 Update `flow/plans/manifest/state.json` `active_registered_tools` is NOT affected (no new tool) — but add a note under `open_doc_debt` or a new `shipped_additions` array recording that DAG widget surfacing is complete (close CA1 from 2026-06-19)
- [ ] 5.4 Verify no regression in `test/dag/dag-store.test.ts` or DAG tool tests — this change is read-only on DagStore

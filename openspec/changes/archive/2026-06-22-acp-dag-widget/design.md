## Context

DAG delegation shipped in PR #7 (`f86448e`) with three tools (`acp_dag_submit`/`status`/`cancel`) backed by `DagStore` / `DagValidator` / `DagExecutor` / `TemplateResolver`. The persistent ACP TUI widget (`src/acp-widget.ts`, 379 lines) predates DAG — it renders sessions, circuit breaker, delegations, and workers, but has zero DAG references.

The `getWidgetState()` builder in `index.ts` already composes state from multiple sources: `SessionManager` (sessions), `WorkerStore` (workers), plus counters for delegations/broadcasts/compares. It does not yet read `DagStore`.

`DagStore` already exposes `listAll()` returning `DagIndexEntry[]` (dagId, status, totalSteps, completedSteps, failedSteps, createdAt, updatedAt) — this is exactly the shape the widget needs.

Stakeholders: users running DAGs want the same live-at-a-glance visibility that sessions/workers already get.

## Goals / Non-Goals

**Goals:**
- Add DAG state to the persistent ACP widget (live progress, failed steps, age, wave).
- Use `DagStore.listAll()` directly — no new state sources, no new persistence.
- Keep the widget backwards-compatible: `dags?: AcpWidgetDag[]` optional, existing fixtures and tests unchanged.
- Match existing render patterns (`STATUS_ICON`, `STATUS_COLOR`, `WORKER_STATUS_ICON`, `timeAgo`).

**Non-Goals:**
- No new pi tools. `acp_dag_status` remains the source of truth for full DAG detail.
- No new state, no DAG-specific persistence, no DAG-specific config fields.
- No DAG cancellation from the widget (user clicks go through `acp_dag_cancel` tool).
- No change to DAG execution semantics, stale detection, or resume logic — those are `dag-resume` / `dag-monitoring` concerns, already covered.
- No DAG-specific colors/icons beyond what existing palettes already provide (`success`/`warning`/`error`/`muted`/`dim`/`accent`).

## Decisions

### D1 — Reuse `DagStore.listAll()` for widget state
**Choice:** `getWidgetState()` calls `dagStore.listAll()` and maps each `DagIndexEntry` into an `AcpWidgetDag` row.

**Rationale:** `listAll()` already reads `dag-index.json` (summary only — no full DAG files). The index entry carries `totalSteps`, `completedSteps`, `failedSteps`, `status`, `createdAt`, `updatedAt`. That's everything the widget needs for a progress row. No per-step detail is required in the widget.

**Alternatives considered:**
- `dagStore.findRunning()` — filters to `status: "running"` only. Rejected: we want to show recently-completed and failed DAGs too, at least for a small history window.
- `dagStore.get(dagId)` per entry — fetches full `DagRecord` with step details. Rejected: overkill for widget; adds per-render I/O for N DAGs.

### D2 — Cap recent-DAG list to avoid unbounded render
**Choice:** Render all running/recent DAGs with `status` in `{running, completed, failed, cancelled}` up to a hard cap of 5 entries, ordered by `updatedAt` descending. DAGs with `status: "pending"` are skipped entirely.

**Rationale:** Prevents pathological render cases (user submits 50 DAGs). Matches the widget's existing pattern of bounded lists (delegation history capped at 20 in `AcpWidgetActivity`).

**Alternative considered:** Time-window filter (e.g., DAGs updated in last 10 minutes). Rejected: adds state that's hard to reason about in tests; count cap is simpler and sufficient.

### D3 — Optional field on `AcpWidgetState`
**Choice:** `dags?: AcpWidgetDag[]` — optional. When absent (e.g., tests using existing fixtures without DAG state), the widget renders identically to today.

**Rationale:** Backwards-compatible for every existing widget test. No migration needed.

### D4 — Additive-only render section
**Choice:** Insert a new render section between sessions and workers (or after workers — see risks below). The new section is a single block that handles all three cases: no DAGs (no render), DAGs present (rows), DAGs present but all completed/failed (one-line summary).

**Rationale:** Minimizes disruption to existing render flow. The widget's existing `render()` function is a linear composition of sections — adding one more is trivial.

**Risks:** The placement relative to workers matters — sessions at top (most important), workers second (live execution), DAGs third (batch coordination). Alternative: DAGs after sessions. Decision deferred to implementation — the spec only requires DAG rows appear when DAGs exist; order is a rendering concern.

### D5 — Failure surfacing
**Choice:** When a DAG is running AND has at least one failed step, render the first failed step ID next to a failure marker (✕). When the DAG is in `failed` terminal state, render the status icon as ✕ (not ✕ on the step, ✕ on the DAG row).

**Rationale:** `DagIndexEntry.failedSteps` is a count, not IDs. We don't surface the specific failed step ID in the widget — we only surface the count. The `✕` marker is visual-only. Users drill into details via `acp_dag_status` tool.

**Correction:** D5 is wrong — `DagIndexEntry` does not carry step IDs. Widget shows `failed: N` count, not specific failed step. Simpler than initially planned.

## Risks / Trade-offs

**[R1] `DagStore.listAll()` reads disk on every widget refresh tick.**
→ Mitigation: `dag-index.json` is a small file (1 entry per DAG). Existing `DagStore` callers (`acp_dag_status` tool, `findRunning` on startup) already read this path. The widget refresh cadence (matches session/worker refresh) is slow enough that disk read cost is negligible. If profiling later shows it's expensive, cache can be added to `DagStore` — not in scope.

**[R2] Widget render tests may not exercise all DAG states exhaustively.**
→ Mitigation: The spec requires one scenario per state class (running, completed, failed, none). Implementation tests follow the `makeState()` fixture pattern used for sessions/workers — no new testing machinery needed.

**[R3] DAG count cap (5) is arbitrary.**
→ Mitigation: Users rarely run more than 5 concurrent DAGs. The cap is documented in the spec (D2). If it becomes a real limit, promote it to a config field in a follow-up.

**[R4] No visual distinction between DAG "running with failures" vs DAG "completely failed" at a glance.**
→ Mitigation: Accept for V1. Drill-down via `acp_dag_status`. If users need finer distinction, add a secondary icon in a follow-up.

## Migration Plan

Additive only. No migration needed. No config change, no runtime path change, no existing tool behavior change.

Rollout:
1. Land the change (types + render + test fixtures).
2. Smoke-test by submitting a DAG via `acp_dag_submit` and verifying the widget shows a row.
3. Verify existing widget tests still pass.

Rollback: `git revert <commit>`. No data migration to undo.

## Open Questions

None. The change is small enough that no outstanding decisions remain. (Earlier drafts discussed render order D4 — deferred to implementation, not a blocker.)

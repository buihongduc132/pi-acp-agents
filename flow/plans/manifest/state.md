# ACP Tools — State Manifest (Notes)

> Human-readable notes for [`state.json`](./state.json). The JSON is the source of truth; this file is the narrative.
>
> Verified 2026-06-19 via teammates (grpA/B/C) + `index.ts` registerTool audit.

## Why two files
- `state.json` — machine-readable, query/filter with `jq`. Source of truth.
- `state.md` (this) — context, callouts, decisions.

## Key facts
- **13 tools** actually registered in `index.ts` (`pi.registerTool`).
- `src/settings/config.ts:22-60 ACP_TOOL_NAMES` is a **legacy list of 39 names** — many consolidated-out. NOT truth.
- `flow/findings/teams-alignment-gaps.md` G-A/B "WorkerStore dead code" claim is **STALE** — workers shipped (`index.ts:1109-1490`, `WorkerStore` 164 lines, `WorkerDispatcher.start()` auto-claim running).

## State values
`implemented` · `partial` · `stub` · `planned` · `deferred` · `to-sunset`

## Callsouts

### CA1 — Workers are real, not stubs
`acp_worker_*` (spawn/list/steer/shutdown/kill/prune) fully wired. G-A finding in `teams-alignment-gaps.md` predates wiring → needs refresh. `acp_worker_shutdown` + `acp_worker_prune` are `partial` only because handshake-ack protocol and heartbeat-derived staleness are still pending (G-K, G-J).

### CA2 — Only 13 registered tools
`ACP_TOOL_NAMES` constant in `config.ts` (39 names) includes consolidated-out names: `acp_delegate`, `acp_delegate_parallel`, `acp_compare`, `acp_session_*`, `acp_task_assign/set_status/dep_*`, `acp_plan_*`, `acp_model_policy_*`, `acp_doctor`, etc. Misleads every consumer. **Prune or delete.**

### CA3 — Orphan doc refs
`test/tdd-consolidation.test.ts:1-24` references 8 requirement docs under `flow/{intentions,requirements}/pi-acp-agents/` that DO NOT EXIST in repo or git history. Recreate or remove the refs.

## Priority decisions (set 2026-06-19)
| Item | Old | New | Why |
|---|---|---|---|
| Predefined teams (G-G) | deferred | **PRI-3** | user bump |
| Auto-claim (G-C), heartbeat (G-J) | PRI-1 | PRI-1 | foundational |
| Branching (G-E) | PRI-4 | **DEFERRED** | non-trivial across ACP transport |
| Worktree (G-F) | deferred | deferred | unchanged |
| Styles (G-H) | defer | **DEFERRED** | cosmetic only |
| task_revoke (new) | — | **MEDIUM** | mid-flight unassign race |

## Known correctness gap — task_unassign mid-flight
`acp_task_update(assignee:"")` sets ONLY `task.assignee=null`. Worker still holds `currentTaskId`, task status unchanged, no session interrupt → **race**. `workerStore.unassignTask()` fires only on kill/prune/natural-finish.

**Suggested fix**: coordinated 4-step — (1) `task.assignee=null`, (2) `task.status="pending"` (re-claimable), (3) `workerStore.unassignTask()` + `updateStatus("idle")`, (4) best-effort `acp_worker_steer`/halt. New `acp_task_revoke` tool OR wire the orchestration into `acp_task_update`. Plan needed: `flow/plans/acp-task-revoke.md`.

## How to query state.json
```bash
# All partial tools
jq '.active_registered_tools[] | select(.state=="partial") | .tool' flow/plans/manifest/state.json

# All planned work by priority
jq -r '.planned[] | "\(.priority)\t\(.capability)"' flow/plans/manifest/state.json | sort

# Which legacy names map to which replacement
jq -r '.consolidated_out_legacy_names[] | "\(.name) → \(.replaced_by)"' flow/plans/manifest/state.json
```

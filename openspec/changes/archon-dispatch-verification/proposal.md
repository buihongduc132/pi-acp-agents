## Why

`archon_run_workflow` returns `accepted:true, status:"started"` from a REST `POST /api/workflows/{name}/run`, but on this Archon 0.4.1 deployment the DAG executor never picks up REST dispatches — `/api/workflows/runs?codebaseId=` returns `[]` for the dispatched codebase. Callers (LLM + users) treat `accepted:true` as proof the workflow is running, then block indefinitely on a silent no-op. This has bitten at least once with `openspec-apply` and is only documented in a finding file, not tracked or guarded.

## What Changes

- **Dispatch honesty**: `archon_run_workflow` SHALL NOT report `status:"started"` as if a run is active. It SHALL return an explicit `dispatched` state plus a `verifiedRunId` field that is `null` until a run is confirmed in `/runs`.
- **Optional verification polling**: add an opt-in `verify` parameter that, after dispatch, polls `/api/workflows/runs?conversationId=` (or `codebaseId=`) for up to N seconds; surfaces the real `runId` / `status` or a definitive "no run materialized" verdict.
- **Diagnostic surface**: on `accepted:true` with no run materializing, the tool result SHALL include the conversation route explanation + a remediation hint (Web UI vs worker adapter) instead of the misleading `started`.
- **Audit logging**: log every dispatch with `{name, conversationId, codebaseId, accepted, httpStatus}` so silent no-ops are traceable post-mortem.
- **Tracking issue**: file a GitHub issue against `buihongduc132/pi-plugins` documenting the REST fire-and-forget gap so it is not lost to a finding file again.
- **BREAKING**: `RunDetails.status` semantics change — `"started"` is removed in favor of `"dispatched"` / `"verified"` / `"unverified"` / `"failed"`. Tool callers parsing this field MUST update.

## Capabilities

### New Capabilities

- `archon-dispatch-verification`: Guarantees `archon_run_workflow` reports whether a workflow run actually materialized after a REST dispatch, with optional polling-based verification and diagnostic remediation hints when the DAG executor never picks up a conversation-routed dispatch.

### Modified Capabilities

<!-- None. The pi-plugins archon extension is not yet covered by an existing openspec spec; this change introduces the first capability spec for it. -->

## Impact

- **Code**: `~/.pi/agent/extensions/pi-archon-workflow/archon-client.ts` (`runWorkflow`, `DispatchResponse` shape), `tools.ts` (`archon_run_workflow` execute + `RunDetails`), `tui.ts` (`renderDispatchNotice`), `dispatch-helpers.ts` (`RunBody` extended with optional `codebaseId` for conversation routing is OUT OF SCOPE per design D2 — verification happens client-side instead).
- **APIs**: Adds client-side polling of existing Archon endpoints `GET /api/workflows/runs?conversationId=` and `GET /api/workflows/runs?codebaseId=`. No new server-side endpoint required.
- **Dependencies**: None new — uses existing `fetch` + `AbortController` for timeout.
- **Test surface**: `archon-client.test.ts`, `tools.test.ts`, `tui.test.ts`, `dispatch-helpers.test.ts` — new cases for verified/unverified/failed paths and polling timeout.
- **Behavior**: LLM callers that previously blocked on `accepted:true` will instead receive a definitive verdict or an explicit `unverified` state they can act on.
- **Out of scope**: fixing the Archon server itself (server-side worker adapter to consume REST dispatches is a separate server-side change tracked by the GitHub issue, not this repo).

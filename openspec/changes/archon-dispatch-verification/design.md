## Context

The pi-plugins `archon_run_workflow` tool wraps Archon 0.4.1's `POST /api/workflows/{name}/run`. Today the tool returns `{accepted: true, status: "started", codebaseId, runId: null, url: null}` and trusts `accepted:true` as proof a workflow run began. Live evidence (`GET /api/workflows/runs?codebaseId=2e120729...&limit=10` → `[]`) shows the DAG executor never picks up REST dispatches on this deployment — `accepted:true` is a transport-level ack, not a run-creation ack. The finding `archon-rest-dispatch-conversation-based.md` explains: REST dispatch is conversation-routed; the orchestrator AI must parse `/invoke-workflow` to actually drive the DAG executor. Skipping that step = silent no-op.

The current client (`archon-client.ts:runWorkflow`) builds the body with `buildRunBody(message, conversationId)` carrying only `{conversationId, message}` (design D2 forbids cwd/codebase on the wire). There is no success-path audit log; only fetch failures and discovery warnings hit `clientLogger`. Callers (LLM) block on `accepted:true` and never get a definitive verdict.

Stakeholders: any LLM caller of `archon_run_workflow`; humans reading the dispatch notice.

## Goals / Non-Goals

**Goals:**
- Make `archon_run_workflow` report whether a run actually materialized, not just whether the HTTP POST was acked.
- Provide optional bounded verification via existing read endpoints (`/runs?conversationId=`, `/runs?codebaseId=`) — no new server-side endpoint.
- Always emit an audit log so silent no-ops are traceable.
- Surface actionable remediation when verification confirms the no-op.
- Preserve design D2: the wire body for `POST /run` stays `{conversationId, message}`.

**Non-Goals:**
- Fixing the Archon server (worker adapter to consume REST dispatches is server-side work, tracked by GitHub issue, not this repo).
- Pre-creating conversations or injecting `/invoke-workflow` automatically. That is a future capability; here we only detect + report.
- Changing the wire body shape. Verification happens client-side via GET on existing endpoints.
- Adding a new MCP/REST endpoint to Archon.

## Decisions

### D1 — Verification is client-side polling, opt-in by default off
**Decision**: Add `verify: boolean = false` to the tool. When on, poll `GET /api/workflows/runs` for the dispatched `conversationId` first, fall back to `codebaseId` after the first empty poll. Backoff 500ms→3000ms, timeout default 15s, max 60s. Abortable.

**Why client-side**: server has no direct-run endpoint (CA1). Client-side polling uses existing read endpoints with no server change. Opt-in by default keeps the common fast path snappy and lets the LLM opt in when it needs certainty (e.g., dispatching `openspec-apply` and intending to wait).

**Alternatives considered**:
- *Server-side direct-run endpoint*: requires Archon 0.5+; out of repo scope. Rejected for this change.
- *Always-on verification*: doubles latency on every dispatch; rejected as default but available as opt-in.

### D2 — `status` vocabulary replaced, no string-compat shim
**Decision**: Remove `"started"`. New values: `"dispatched" | "verified" | "unverified" | "failed"`.

**Why no shim**: the only consumer of `RunDetails.status` is the LLM, which reads text; a hard break forces the model to re-read semantics instead of silently treating `"started"` as a real run. Plugin-message-isolation means no external system parses this string.

**Alternatives**:
- Keep `"started"` and add a `verified: bool` sibling — ambiguous ("started" still implies a run began). Rejected.

### D3 — Verification query strategy: conversationId first, codebaseId fallback
**Decision**: Poll `/runs?conversationId=<id>` once. If empty AND `codebaseId` is resolvable, switch to `/runs?codebaseId=<id>` for remaining polls. Match by `conversation_id` on codebaseId results to disambiguate from concurrent runs.

**Why**: REST dispatch carries the `conversationId` on the wire — if a run materializes it will carry that id. CodebaseId is broader and may return unrelated runs, but it's the only fallback when conversationId doesn't propagate.

**Alternatives**:
- *codebaseId only*: noisy with concurrent runs; harder to attribute the match.
- *conversationId only*: zero fallback when the server doesn't propagate conversationId into the run record.

### D4 — Remediation surface is generic, no plugin-name leak
**Decision**: The `remediation` object on `unverified` carries three strings — `cause`, `webUiTrigger` (base endpoint URL), `cliFallback` (`archon workflow run <name> --message <message>`). No plugin name appears. Honors the plugin-message-isolation rule.

**Alternatives**:
- Name the plugin: violates isolation rule. Rejected.

### D5 — Audit log on every dispatch, info level, fixed fields
**Decision**: `toolsLogger.info("dispatch", {name, conversationId, codebaseId, accepted, httpStatus, verify, finalStatus, pollMs?})`. Fires on all 4 final statuses. Uses existing logger; no new sink.

**Why info not warn**: a verified dispatch is normal; warn-level noise would dilute real warnings. The structured fields make post-mortem grepping deterministic.

**Alternatives**:
- Log only failures: defeats silent-no-op traceability (the exact bug we're fixing).
- New audit file: more surface area, no value over structured logger.

### D6 — TUI notice rewritten for honesty
**Decision**: `renderDispatchNotice` switches on `status`:
- `dispatched` → "✓ dispatched (server ack only — not yet verified)"
- `verified` → "✓ verified running — runId <id>"
- `unverified` → "⚠ dispatched but no run materialized — see remediation"
- `failed` → "✗ failed: <error>"

The `accepted:` / `status:` two-line format is preserved on `dispatched`/`verified`/`failed` for visual continuity; `unverified` gets the warning glyph.

### D7 — GitHub issue filed as a task, not as part of this code change
**Decision**: tasks.md includes a task to file the tracking issue against `buihongduc132/pi-plugins` capturing E1-E3 and CA1-CA2. The issue is the durable record; this repo change is the client-side mitigation.

## Risks / Trade-offs

- **[Verification false-negative]** Conversation routing on the server may take >15s for the orchestrator AI to emit `/invoke-workflow`. → Default timeout 15s is a tunable; `verifyTimeoutMs` lets the LLM raise it to 60s. Document in tool description that 15s is optimistic for conversation-routed flows.
- **[Polling load on Archon server]** Every verified dispatch hits `/runs` up to ~10 times. → Exponential backoff, max 60s per call, opt-in. Server `/api/health` shows `maxConcurrent:1000` — 10 GETs per dispatch is negligible.
- **[Breaking `status` string]** Any downstream caller parsing `"started"` breaks. → Only consumer is the LLM; proposal marks this BREAKING. TUI is updated in same change.
- **[conversationId not propagated]** If the server's run record omits `conversation_id`, the conversationId-first poll never matches. → codebaseId fallback mitigates; documented in spec scenario.
- **[Race with concurrent same-codebase runs]** codebaseId fallback may attribute a concurrent run to our dispatch. → Match on `conversation_id` field after fetch; if absent, fall through to `unverified` rather than false-positive.
- **[Remediation becomes stale]** If Archon adds a direct-run endpoint later, the remediation text misleads. → Tie remediation text to deployment version detection (`/api/health.version`); for now assume 0.4.x. Note as open question.

## Migration Plan

1. Land code change (4 file edits + tests). Tests cover all 4 status paths and poll timeout.
2. File tracking issue (task in tasks.md).
3. No deploy coordination needed — this is a pi-plugins extension, ships with the next pi-plugins deploy.
4. Rollback: revert the extension; existing `"started"` behavior restored.

## Open Questions

- Should `verifyTimeoutMs` default be 15s or 30s? 15s picked for fast-path snappiness; revisit after real-world conversation-routed latency data.
- Should the remediation block detect Archon version via `/api/health.version` and change wording for 0.5+? Defer until 0.5 ships.
- Should we expose a separate `archon_verify_run` tool for verifying a prior dispatch by `conversationId`? Out of scope for this change; candidate for a follow-up.

PARKED: stale duplicate — canonical copy relocated to pi-plugins (86773c9c). Target code lives in pi-plugins, not pi-acp-agents. Awaiting pi-plugins owner to delete this copy. CA36.

## 1. Client-layer dispatch types and audit logging

- [ ] 1.1 In `archon-client.ts`, extend `DispatchResponse` to `{ accepted: boolean; status: "dispatched" | "verified" | "unverified" | "failed"; httpStatus: number }`. Update `runWorkflow` to capture `httpStatus` from the `Response` and return `status: "dispatched"` (not `"started"`) on `accepted:true`, `"failed"` otherwise. Preserve wire body `{conversationId, message}` (D2 unchanged).
- [ ] 1.2 Add `verifyDispatch` method to `ArchonClient` interface and implementation: `verifyDispatch(conversationId: string, codebaseId: string | null, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ runId: string | null; status: string | null; matchedBy: "conversation" | "codebase" | null; pollMs: number }>`. Implementation: poll `GET /api/workflows/runs?conversationId=` first; on first empty result switch to `GET /runs?codebaseId=` when codebaseId non-null; backoff 500ms→3000ms; abort on timeout/signal. Match by `conversation_id` field when falling back to codebaseId to avoid false positives from concurrent runs.
- [ ] 1.3 Add `MAX_VERIFY_TIMEOUT_MS = 60000` const + clamp helper `clampVerifyTimeout(input: number | undefined): { value: number; clamped: boolean }` (default 15000). Used by tools layer; exported for tests.

## 2. Tool-layer integration

- [ ] 2.1 In `tools.ts`, extend `archon_run_workflow` parameters: `verify?: boolean`, `verifyTimeoutMs?: number`. Update `RunDetails` type: replace `status: string` with the 4-value union; add `verifiedRunId: string | null`, `verifiedStatus?: string`, `verifiedAt?: string`, `remediation?: { cause: string; webUiTrigger: string; cliFallback: string }`, `pollMs?: number`. Remove `runId: null` / `url: null` (already always null).
- [ ] 2.2 Rewrite `archon_run_workflow` `execute`: dispatch via `client.runWorkflow`; if `verify === true && result.accepted`, call `client.verifyDispatch` with `AbortController` and clamped timeout; map outcome to `verified` / `unverified`. On `unverified`, build the remediation object per D4 (no plugin name). Always emit `toolsLogger.info("dispatch", {name, conversationId, codebaseId, accepted, httpStatus, verify, finalStatus, pollMs?})` per D5 before returning.
- [ ] 2.3 Update the tool `description` to document: (a) `accepted:true` ≠ running on this deployment; (b) `verify` opt-in behavior + default 15s/60s ceiling; (c) the 4 status values and their meanings. Keep description under 600 chars.

## 3. TUI notice rewrite

- [ ] 3.1 In `tui.ts`, update `renderDispatchNotice` to switch on the new `status` values per design D6: `dispatched` → "✓ dispatched (server ack only — not yet verified)" + keep accepted/status lines; `verified` → "✓ verified running — runId <id>"; `unverified` → "⚠ dispatched but no run materialized — see remediation"; `failed` → "✗ failed: <error>".
- [ ] 3.2 Update any TUI dispatch result mapping (the inline `RunDispatchResult` builder in `tui.ts`) to carry `verifiedRunId` / `verifiedStatus` / `verifiedAt` through to the notice renderer.

## 4. Tests

- [ ] 4.1 In `archon-client.test.ts`: add cases for `runWorkflow` returning `status: "dispatched"` with `httpStatus: 200` and `status: "failed"` with non-2xx. Mock `fetch`.
- [ ] 4.2 In `archon-client.test.ts`: add cases for `verifyDispatch` — (a) conversationId match on first poll → returns runId early; (b) empty conversationId, codebaseId fallback match; (c) timeout → `{runId: null, matchedBy: null}`; (d) concurrent same-codebase run without conversation_id match → no false positive.
- [ ] 4.3 In `dispatch-helpers.test.ts`: add case for `clampVerifyTimeout` clamping `120000` → `60000` and applying default `15000` when undefined.
- [ ] 4.4 In `tools.test.ts`: add cases for `archon_run_workflow` returning each of `dispatched` (verify off), `verified`, `unverified` (with remediation block present, no plugin name), `failed`. Assert `toolsLogger.info` audit call shape via mock.
- [ ] 4.5 In `tui.test.ts`: assert the 4 `renderDispatchNotice` output strings per D6.
- [ ] 4.6 Assert no plugin-name leak (`pi-archon-workflow`) appears in `remediation` text across all new test cases.

## 5. Tracking issue

- [ ] 5.1 File a GitHub issue against `buihongduc132/pi-plugins` titled "REST dispatch (`archon_run_workflow`) accepted but not running on Archon 0.4.x" capturing: E1-E3 (empty `/runs?codebaseId=`, conversation-routed REST, no tracking issue), C1-C2 (conversation routing, no runId), CA1-CA2 (design gap, finding file). Link this change's proposal.md. Do NOT close it in this change — it tracks the server-side fix.

## 6. Verification

- [ ] 6.1 Run full test suite for the extension (`mise run test` or project equivalent) — all green.
- [ ] 6.2 Manual smoke: dispatch `openspec-apply` with `verify: true` against the live endpoint; confirm the tool returns `unverified` with remediation within ~15s, and that `/runs?codebaseId=` remains empty as expected.
- [ ] 6.3 Re-run `openspec status --change "archon-dispatch-verification"` and confirm `applyRequires: ["tasks"]` is satisfied; all artifacts done.

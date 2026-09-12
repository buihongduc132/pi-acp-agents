## ADDED Requirements

### Requirement: Dispatch response distinguishes server ack from verified run
The `archon_run_workflow` tool SHALL return a `RunDetails` object whose `status` field uses one of: `"dispatched"`, `"verified"`, `"unverified"`, `"failed"`. The value `"started"` is REMOVED. `"dispatched"` means the server returned `accepted:true` from `POST /api/workflows/{name}/run` and verification was not requested. `"verified"` means a run record was found in `/api/workflows/runs` for the dispatched `conversationId` or `codebaseId` after polling. `"unverified"` means verification was requested and completed but no run materialized within the poll window. `"failed"` means the server rejected the dispatch or the HTTP call errored.

#### Scenario: Default dispatch without verify returns dispatched state
- **WHEN** the LLM calls `archon_run_workflow` with `{name: "openspec-apply", message: "..."}` and omits `verify`
- **THEN** the tool returns `status: "dispatched"`, `verifiedRunId: null`, and a `note` explaining that `accepted:true` does not guarantee the DAG executor picked up the dispatch on this deployment

#### Scenario: Verify requested and run materializes
- **WHEN** the LLM calls `archon_run_workflow` with `{name: "openspec-apply", message: "...", verify: true}` and a run matching the dispatched `conversationId` appears in `/runs` within the poll window
- **THEN** the tool returns `status: "verified"`, `verifiedRunId: "<run-id>"`, `verifiedStatus: "<run.status>"`, and `verifiedAt: <ISO timestamp>`

#### Scenario: Verify requested and no run materializes
- **WHEN** the LLM calls `archon_run_workflow` with `{verify: true}` and the poll window elapses with zero runs matching the dispatched `conversationId` or `codebaseId`
- **THEN** the tool returns `status: "unverified"`, `verifiedRunId: null`, and a `remediation` field naming the conversation-routed nature of REST dispatch plus the recommended fallbacks (Web UI trigger, or CLI `archon workflow run`, or pre-create conversation + inject `/invoke-workflow`)

#### Scenario: Server rejects dispatch
- **WHEN** the LLM calls `archon_run_workflow` and the server returns a non-2xx status or `accepted: false`
- **THEN** the tool returns `status: "failed"`, `ok: false`, and an `error` field containing the server response body

### Requirement: Verify parameter polls existing run endpoints with bounded timeout
The `archon_run_workflow` tool SHALL accept an optional `verify` parameter (boolean, default `false`) and optional `verifyTimeoutMs` (integer, default `15000`, max `60000`). When `verify: true`, after the dispatch HTTP call returns `accepted:true`, the tool SHALL poll `GET /api/workflows/runs?conversationId=<conversationId>` first; if that returns zero runs, fall back to `GET /api/workflows/runs?codebaseId=<codebaseId>`. Polling SHALL use an exponential backoff starting at 500ms, capped at 3000ms, and SHALL abort the loop when `verifyTimeoutMs` elapses. The loop SHALL be cancellable via `AbortController`.

#### Scenario: ConversationId match wins over codebaseId fallback
- **WHEN** verification polls `/runs?conversationId=<id>` and finds a run
- **THEN** the tool SHALL stop polling and return that run's id/status without querying by codebaseId

#### Scenario: ConversationId empty, codebaseId fallback used
- **WHEN** `codebaseId` is resolvable and `/runs?conversationId=` returns zero runs after the first poll
- **THEN** the tool SHALL switch to `/runs?codebaseId=<id>` for subsequent polls

#### Scenario: Timeout aborts the loop
- **WHEN** `verifyTimeoutMs` elapses mid-poll without a matching run
- **THEN** the tool SHALL stop polling and return `status: "unverified"` with the elapsed duration recorded

#### Scenario: Timeout capped at maximum
- **WHEN** the caller passes `verifyTimeoutMs: 120000`
- **THEN** the tool SHALL clamp the effective timeout to `60000` and log a warning

### Requirement: Diagnostic remediation surface
When the tool returns `status: "unverified"`, the `content[0].text` SHALL include a `remediation` object with three string fields: `cause` ("REST dispatch is conversation-routed on this Archon deployment and the DAG executor did not pick up the dispatch within the poll window"), `webUiTrigger` (the base endpoint URL), and `cliFallback` (the exact CLI command form `archon workflow run <name> --message <message>`). The diagnostic SHALL NOT reference the plugin name `pi-archon-workflow` in user-facing text (plugin-message-isolation).

#### Scenario: Remediation block appears on unverified
- **WHEN** the tool returns `status: "unverified"`
- **THEN** the `content[0].text` JSON SHALL contain a `remediation` object with `cause`, `webUiTrigger`, and `cliFallback` keys, none of which mention a plugin name

#### Scenario: Remediation block absent on verified
- **WHEN** the tool returns `status: "verified"`
- **THEN** the `content[0].text` JSON SHALL NOT contain a `remediation` key

### Requirement: Audit log of every dispatch
The `archon_run_workflow` tool SHALL emit an info-level audit log on every dispatch attempt with `{name, conversationId, codebaseId, accepted, httpStatus, verify, finalStatus}`. Audit logs SHALL use the existing `toolsLogger`. The audit log SHALL fire even when verification is off, even when the dispatch is rejected, and even when verification times out — so post-mortem reconstruction of silent no-ops is always possible.

#### Scenario: Audit log fires on successful verified dispatch
- **WHEN** a dispatch returns `status: "verified"`
- **THEN** `toolsLogger.info` SHALL be called once with the dispatch audit record including `finalStatus: "verified"`

#### Scenario: Audit log fires on rejected dispatch
- **WHEN** the server returns HTTP 4xx and the tool returns `status: "failed"`
- **THEN** `toolsLogger.info` SHALL be called with `accepted: false, finalStatus: "failed"`

#### Scenario: Audit log fires on unverified timeout
- **WHEN** verification times out and the tool returns `status: "unverified"`
- **THEN** `toolsLogger.info` SHALL be called with `accepted: true, finalStatus: "unverified"` and the elapsed poll duration

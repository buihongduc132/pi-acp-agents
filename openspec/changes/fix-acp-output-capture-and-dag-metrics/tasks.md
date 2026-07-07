## 1. Output cleaning (C2/C5/C6)

- [ ] 1.1 Create `src/core/output-cleaner.ts` with a `stripAgentBootBanner(text: string): string` function implementing the marker-based stripping algorithm (design.md D1). Known markers: `MCP: N servers connected (N tools)` line, `hindsight:...recall...` status lines. Strip from beginning of text up to and including the last marker. Fall back to original text if no markers found or stripped result is empty.
- [ ] 1.2 Write unit tests in `test/core/output-cleaner.test.ts` covering: (a) pi boot banner + real answer, (b) no markers present (passthrough), (c) empty-after-strip fallback, (d) multiple consecutive markers, (e) marker appears in legitimate response (only strip from prefix, not middle).
- [ ] 1.3 Wire `stripAgentBootBanner` into `AcpClient.prompt()` (`src/core/client.ts:614`) — apply to `this.collectedText` before returning. Verify `quickPrompt()` and `delegate()` return paths inherit the cleaned text.
- [ ] 1.4 Verify (via existing tests + new assertions) that DAG step output, `acp_fanout` broadcast results, `acp_fanout` compare input, `async-executor` run records, and `acp_spawn` one-shot return all receive cleaned text. Add integration test in `test/dag/dag-smoke-output-cleaning.test.ts` asserting step `output` contains no `pi v` banner, no `## Skills` header, no `MCP: ... servers connected`.

## 2. Wave counter persistence (C1)

- [ ] 2.1 Add `updateDagWave(dagId, { currentWave, totalWaves })` method to `DagStore` (`src/dag/dag-store.ts`) that writes only `currentWave`, `totalWaves`, and bumps `updatedAt` without touching step state. Add unit test in `test/dag/dag-store.test.ts`.
- [ ] 2.2 In `DagExecutor.execute()` (`src/dag/dag-executor.ts`), after computing `waves = this.topologicalSort(record.tasks)`, call `store.updateDagWave(dagId, { currentWave: 0, totalWaves: waves.length })` before the wave loop begins.
- [ ] 2.3 At the start of each wave iteration in `execute()`, call `store.updateDagWave(dagId, { currentWave: waveIndex + 1, totalWaves: waves.length })` (1-indexed).
- [ ] 2.4 Add test in `test/dag/dag-smoke-submit-status.test.ts` asserting: after wave 2 of 3 begins, `acp_dag_status` returns `currentWave: 2, totalWaves: 3` (not 0/0). After completion, both equal 3.

## 3. Timestamp integrity (C3)

- [ ] 3.1 Add debug logging to `DagExecutor.dispatchStep` that logs every `store.updateStep` call for a step with the resulting `startedAt`/`completedAt` values. Submit a fresh 3-step DAG and inspect logs to pin which write clobbers `startedAt`.
- [ ] 3.2 Based on 3.1 findings, fix the write path: ensure `startedAt` is written exactly once at `running` transition and preserved (via `...s` spread) in all subsequent `updateStep` calls. If the store's deep-copy in `updateStep` is the cause, fix the merge logic in `dag-store.ts:updateStep`.
- [ ] 3.3 Add test asserting `durationMs ≈ parse(completedAt) - parse(startedAt)` within 1000ms tolerance for a completed step (covers the `dag-execution` timestamp-integrity requirement).
- [ ] 3.4 Add test asserting `startedAt` does not change between the `running` write and the `completed` write (read record after running, read after completed, compare).

## 4. Regression & verification

- [ ] 4.1 Run the full DAG smoke test suite: `test/dag/dag-smoke-*.test.ts`. All must pass.
- [ ] 4.2 Run the ACP widget DAG tests (`test/acp-widget-dag-*.test.ts`) — widget rendering depends on `currentWave`/`totalWaves` for progress display; verify widget shows real progress now.
- [ ] 4.3 Submit a live 3-step linear "hello world" DAG against the real `pi` agent and verify via `acp_dag_status`: (a) wave counters are non-zero and correct, (b) step outputs contain only `hello world N` (no banner), (c) `durationMs` matches `completedAt - startedAt`.
- [ ] 4.4 Update `flow/plans/manifest/state.json` `active_tool_count` and any references to wave counter status. Add a finding doc in `flow/findings/` recording the bugs + fix for future reference.

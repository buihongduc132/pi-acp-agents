## Why

Live DAG smoke test (3-step linear "hello world" chain, dagId `8857022e`) exposed three bugs in the ACP output + DAG observability path:

1. **Output pollution** — `AcpClient.collectedText` accumulates every `agent_message_chunk` + `agent_thought_chunk` into one string. pi emits its boot banner (version, Context, 140 Skills, 90 Prompts, 30 Extensions, hindsight/MCP status lines) as message chunks before the real answer. `result.text` therefore contains ~12KB of boot noise + the actual answer. In DAG, this polluted output flows into downstream prompts via `{step.output}` template resolution — step 2 receives 12KB of garbage context from step 1. `acp_fanout` compare mode compares boot banners instead of real answers. `async-executor` persists polluted text in run records.

2. **Dead wave counters** — `DagRecord.currentWave` and `totalWaves` are initialized to 0 in `dag-store.ts:116-117`, surfaced in `acp_dag_status` response, but never updated during execution. The `dag-monitoring` spec requires `currentWave: 2, totalWaves: 3` in status queries — the implementation returns 0/0 forever.

3. **Timestamp/duration mismatch** — `startedAt`/`completedAt` ISO timestamps disagree with `durationMs` (which is correct). In the smoke test: s1 `startedAt=07:57:54.151`, `completedAt=07:57:54.790` (Δ=639ms), but `durationMs=17906`. Sum of all `durationMs` = 56,342ms matches wall-clock 56,347ms — so durationMs is truthful, timestamps are the liars. Root cause not fully pinned from static analysis; likely a second `updateStep` write clobbering timestamps after delegate resolves.

These bugs degrade trust in DAG observability and waste tokens on polluted downstream prompts. The output pollution affects every tool that consumes `result.text` (acp_spawn one-shot, acp_fanout broadcast/compare, async-executor, DAG steps).

## What Changes

- **Output capture layer**: introduce a clean-output extraction step that separates agent boot/context noise from the actual assistant response. `AcpClient.collectedText` (or a new wrapper) must strip the boot banner before returning `result.text`. All downstream consumers (DAG step output, fanout results, async-executor run records, acp_spawn one-shot return) inherit the cleaned output.
- **Wave counter tracking**: `DagExecutor.execute()` must persist `currentWave` and `totalWaves` to the `DagStore` during the wave loop (not just compute them locally). `acp_dag_status` then returns truthful wave progress.
- **Timestamp integrity**: audit every `updateStep` call in `DagExecutor.dispatchStep` to ensure `startedAt` is written exactly once at dispatch entry and `completedAt` is written exactly once at dispatch exit, with no subsequent write clobbering them. Add a runtime assertion or test that `durationMs ≈ parse(completedAt) - parse(startedAt)` within a small tolerance.

## Capabilities

### New Capabilities
- `output-capture`: Clean extraction of agent assistant text from the raw chunk stream. Defines what constitutes "boot noise" vs "real answer", the stripping algorithm, and the contract that `result.text` returned to any caller contains only the assistant's response to the prompt.

### Modified Capabilities
- `dag-execution`: Wave counter persistence — executor must write `currentWave`/`totalWaves` to store during execution. Timestamp write ordering — `startedAt`/`completedAt` must not be clobbered by subsequent writes.
- `dag-monitoring`: `acp_dag_status` must return truthful `currentWave`/`totalWaves` (per existing spec requirement, currently unmet).

## Impact

- **Code**: `src/core/client.ts` (collectedText / prompt), `src/dag/dag-executor.ts` (wave counter writes, timestamp ordering), `src/dag/dag-store.ts` (updateStep contract for timestamps), `src/coordination/coordinator.ts` (delegate return path), `src/core/async-executor.ts` (result.text persistence).
- **Tools affected**: `acp_dag_submit`, `acp_dag_status`, `acp_spawn` (one-shot), `acp_fanout` (broadcast + compare), `acp_msg` (live session prompt return).
- **Tests**: existing DAG smoke tests (`test/dag/dag-smoke-*.test.ts`) need new assertions for wave counters, timestamp consistency, and clean output. New test suite for output-capture stripping logic.
- **Breaking**: none — the fix makes behavior match the documented contract. Any consumer relying on the polluted text (unlikely) would see shorter/cleaner output.
- **Out of scope**: per-step cold spawn overhead (C4, ~17s each) — this is a design decision (short-lived delegate), not a bug. Session reuse for DAG steps is a separate optimization that belongs in a different change.

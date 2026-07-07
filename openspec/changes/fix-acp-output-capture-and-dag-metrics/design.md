## Context

The ACP DAG system was smoke-tested with a 3-step linear "hello world" chain. Three bugs surfaced:

1. **Output pollution**: `AcpClient.collectedText` accumulates ALL `agent_message_chunk` + `agent_thought_chunk` events into one string. pi emits its boot banner (~12KB: version, Context, Skills, Prompts, Extensions, MCP/hindsight status) as message chunks before the actual answer. This polluted text flows through `result.text` → DAG step output → `{step.output}` template → downstream prompts. Also affects `acp_fanout` compare/broadcast, `acp_spawn` one-shot, and `async-executor` run records.

2. **Dead wave counters**: `DagRecord.currentWave` and `totalWaves` are initialized to 0 at creation (`dag-store.ts:116-117`) and never updated during execution. The executor computes waves locally in `topologicalSort()` but never persists the wave index or total back to the store. `acp_dag_status` returns these fields, so consumers see `currentWave: 0, totalWaves: 0` forever.

3. **Timestamp/duration mismatch**: `startedAt`/`completedAt` timestamps are ~639ms apart but `durationMs` is 17,906ms. The `durationMs` is computed as `Date.parse(completedAt) - Date.parse(startedAt)` inside `dispatchStep`, which should be consistent — but the persisted timestamps don't match. This suggests a second `updateStep` call is overwriting the timestamps after the initial write. The sum of all `durationMs` matches wall-clock, so durationMs is correct and timestamps are wrong.

## Goals / Non-Goals

**Goals:**
- Clean agent output: strip boot banner / context noise from `result.text` so downstream consumers get only the assistant's actual response
- Fix wave counter persistence: `currentWave` and `totalWaves` reflect actual execution progress
- Fix timestamp integrity: `startedAt`/`completedAt` consistent with `durationMs`
- Add tests that catch regressions for all three bugs

**Non-Goals:**
- Session reuse for DAG steps (C4 cold-spawn overhead) — separate optimization, different change
- Changing the ACP protocol or adapter interface
- Modifying pi's boot banner behavior (upstream concern)

## Decisions

### D1: Output cleaning — strip in `AcpClient.prompt()`, not in each consumer

**Choice**: Add a `stripBootBanner(text: string): string` utility in `src/core/output-cleaner.ts`. Apply it once in `AcpClient.prompt()` before returning `collectedText`.

**Alternatives considered**:
- Strip in each consumer (DAG executor, fanout, spawn) → duplicated logic, easy to miss new consumers
- Strip at adapter level → adapters don't know what's "boot" vs "answer"
- Configure pi to suppress banner → upstream change, out of scope

**Stripping algorithm**:
1. Find the last occurrence of a known banner boundary pattern. pi's boot output ends with a recognizable pattern: the line `MCP: N servers connected (N tools)` followed by optional `hindsight:` lines. The actual answer starts after these.
2. Alternative heuristic: look for the last `\n` before a short final segment (the real answer is typically <200 chars for simple prompts). But this is fragile.
3. **Primary approach**: Strip everything before and including the last known system-line pattern. Known patterns to strip up to:
   - Lines starting with `hindsight:` 
   - Lines matching `MCP: \d+ servers connected`
   - The `pi v\d+\.\d+\.\d+` header and everything up to the end of the Extensions/Prompts listing
4. **Fallback**: If no known pattern found, return text as-is (don't break agents that don't emit banners).

**Refined approach**: Instead of fragile pattern matching on pi's output format, use a **smarter heuristic**: pi's boot banner is emitted as structured chunks before the prompt is even sent. The actual response to the prompt comes AFTER the prompt is sent. We can split `collectedText` at the boundary by tracking WHEN chunks arrive relative to the prompt being sent.

Actually, the simplest robust approach: since `collectedText` is reset at the start of each `prompt()` call (line 574), and the boot banner is emitted during `connect()`/`initialize()`/`newSession()` phase — we need to check if the banner is actually in `collectedText` or if it's coming from somewhere else.

**Revised investigation needed**: The boot banner might be arriving as `agent_message_chunk` events during the prompt phase because pi sends its context summary as part of the response. In that case, we need pattern-based stripping.

**Final decision**: Pattern-based stripping with known pi banner markers. The strip function:
1. Look for the last occurrence of `MCP: \d+ servers connected \(\d+ tools\)` or `hindsight:.*recall.*:` line
2. If found, take everything after that line (trimmed)
3. If not found, return text as-is
4. Edge case: if the stripped result is empty, return original text

### D2: Wave counters — persist in the wave loop

**Choice**: In `DagExecutor.execute()`, after computing waves and during the wave loop, call `store.updateDagWave(dagId, { currentWave: waveIndex + 1, totalWaves: waves.length })`.

**Implementation**: Add a new `DagStore.updateDagWave()` method that updates only `currentWave`, `totalWaves`, and `updatedAt` without touching step state. This avoids the overhead of `updateStep` for a metadata-only change.

**Alternative**: Update the `DagRecord` in-memory and do a single write at the end. Rejected because if the process crashes mid-execution, the wave progress is lost.

### D3: Timestamp fix — single write per transition

**Choice**: The root cause is likely that `updateStep` is called multiple times for the same step (e.g., once for `running` status, once for `completed`), and the `startedAt` field from the `running` write is being overwritten by the `completed` write which doesn't carry forward the original `startedAt`.

**Fix**: In `dispatchStep`, capture `startedAt` once. When writing the completed state, explicitly preserve the original `startedAt` by reading it from the current record and passing it through. Add a guard: `startedAt` MUST NOT be overwritten if already set.

**Alternative**: Change `updateStep` to merge rather than replace. Rejected — the mutate callback pattern already does merge, but the callback in the `completed` path may not be reading the existing `startedAt`.

**Concrete fix**: In the `completed` path of `dispatchStep`:
```typescript
const completedAt = new Date().toISOString();
const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
const updated = this.store.updateStep(dagId, step.id, (s) => ({
    ...s,
    status: "completed",
    output: result.text,
    error: undefined,
    completedAt,
    durationMs,
    // startedAt is preserved from `s` (the existing record) via spread
}));
```
The `...s` spread should preserve `startedAt` from the running state. If it's not working, the issue is that the `startedAt` in the `running` write and the `completed` write are both set to `new Date().toISOString()` at the same moment, or the store's deep-copy in `updateStep` is losing it. Need runtime debugging.

**Pragmatic approach**: Add a test that asserts `durationMs ≈ parse(completedAt) - parse(startedAt) ± 1000ms`. If it fails, we know the bug is in the write path. Then add logging to trace which `updateStep` calls are made for a given step.

## Risks / Trade-offs

- **[Risk] Boot banner pattern changes** → The stripping patterns are coupled to pi's output format. If pi changes its banner format, stripping breaks silently. **Mitigation**: Fallback to returning text as-is when no patterns match. Add a test with a sample banner. Log when stripping occurs.
- **[Risk] Stripping removes legitimate output** → If an agent's actual response contains text that looks like banner markers. **Mitigation**: Only strip from the BEGINNING of the text, never from the middle. Use `indexOf` + slice, not global replace.
- **[Risk] Wave counter writes add I/O overhead** → Extra `updateDagWave` calls per wave. **Mitigation**: Only one write per wave (not per step), and it's a small JSON file write. Negligible.
- **[Risk] Timestamp fix doesn't resolve root cause** → If the issue is deeper in the store's merge logic. **Mitigation**: Add the consistency assertion as a test. If it fails after the fix, we have a reproducible test case to debug.

## ADDED Requirements

### Requirement: Agent boot banner stripped from returned output
The `AcpClient` SHALL strip agent boot/context banner noise from the text returned via `result.text` before it reaches any downstream consumer (DAG step output, fanout results, async-executor run records, acp_spawn one-shot return). Only the assistant's actual response to the prompt SHALL be returned.

#### Scenario: Strip pi boot banner before real answer
- **WHEN** pi emits a response containing a boot banner (`pi v0.79.3\n---\n\n## Context\n...## Prompts\n...## Extensions\n...\nhindsight: [...] recall (sync): fail (3.7s)MCP: 1 servers connected (63 tools)hello world 1`) followed by the actual answer (`hello world 1`)
- **THEN** the `result.text` returned to the caller SHALL be exactly `hello world 1` with no boot banner, skills list, prompts list, or MCP/hindsight status lines

#### Scenario: Return text as-is when no banner detected
- **WHEN** an agent returns a response that does not contain any known boot banner marker patterns (e.g., a raw LLM response without framework wrappers)
- **THEN** the `result.text` SHALL be returned unchanged

#### Scenario: Preserve legitimate multi-section responses
- **WHEN** the assistant's actual response contains multiple sections, markdown headers, or tool output
- **THEN** the stripping SHALL only remove recognized banner markers from the beginning of the text and SHALL NOT remove legitimate response content that appears after the answer begins

### Requirement: Stripping boundary detection
The stripping algorithm SHALL identify the boundary between boot context noise and the real answer using known marker patterns. Known markers SHALL include: the `MCP: N servers connected (N tools)` line, and `hindsight:...recall...` status lines. The real answer SHALL be the text after the last occurrence of any known marker.

#### Scenario: Multiple banner markers present
- **WHEN** the raw text contains `hindsight: [pi-acp-agents] recall (sync): fail (3.7s)MCP: 1 servers connected (63 tools)hello world 1`
- **THEN** the stripper SHALL find the last marker (`MCP: 1 servers connected (63 tools)`) and return only `hello world 1`

#### Scenario: Empty result after stripping falls back
- **WHEN** stripping all matched markers would result in an empty string
- **THEN** the original text SHALL be returned unchanged to avoid data loss

### Requirement: Output cleaning applies to all consumers
Every code path that returns `result.text` to a caller SHALL receive the cleaned output. This includes: `AgentCoordinator.delegate()` return, `AgentCoordinator.broadcast()` results, `AcpClient.quickPrompt()`, `AcpClient.prompt()`, and `AsyncExecutor.start()` run records.

#### Scenario: DAG step output is clean
- **WHEN** a DAG step dispatched via `coordinator.delegate()` completes
- **THEN** the step's persisted `output` field SHALL contain only the assistant's response, with no boot banner

#### Scenario: Fanout broadcast results are clean
- **WHEN** `coordinator.broadcast()` returns results from N agents
- **THEN** each result's `text` field SHALL contain only the respective agent's actual response

#### Scenario: Fanout compare diffs real answers not banners
- **WHEN** `acp_fanout` runs in compare mode across 2 agents
- **THEN** the comparison SHALL diff the agents' actual responses, not their (largely identical) boot banners

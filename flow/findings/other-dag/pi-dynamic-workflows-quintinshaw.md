# pi-dynamic-workflows — QuintinShaw fork

- **URL**: https://github.com/QuintinShaw/pi-dynamic-workflows/
- **Pattern**: Script mode, Claude-Code-style
- **Target**: pi subagents

## Mix script+LLM
LLM authors JS script. `agent()` spawns subagent. `parallel()` fans out. `phase()` groups. `tier` routes model. Code = control flow, LLM = work.

## Key features
- **Fan-out orchestration** — up to 16 concurrent / 1000 total subagents
- **Real model routing** — `small`/`medium`/`big` tiers OR exact `model`. Actually switches subagent model.
- **Agent options**: `tier`, `model`, `agentType`, `isolation: "worktree"`, `schema`, `label`, `phase`, `timeoutMs`
- **Quality patterns built-in**: `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`
- **Human approval gates**: `checkpoint(prompt, opts)` — journaled, replayable
- **Budget tracker**: `{ total, spent(), remaining() }` real-token
- **Worktree isolation** per agent
- `/workflows` TUI manager
- `ultracode` standing opt-in
- Deep research mode

## Borrow for ACP
- **Built-in quality patterns** (`verify`, `judgePanel`, `loopUntilDry`) ← ACP DAG has no quality-gate per step. Big gap.
- **Tier-based model routing** ← ACP workers specify model directly, no tier abstraction.
- **`checkpoint` human approval** ← ACP DAG has no human-in-loop gates.
- **Real budget tracker** ← ACP DAG has no token budget enforcement.
- **Worktree isolation per step** ← cross-ref G-F (deferred for ACP workers).

## Refs
- [QuintinShaw/pi-dynamic-workflows README](https://github.com/QuintinShaw/pi-dynamic-workflows/)

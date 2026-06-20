# pi-dynamic-workflows — Michaelliv original

- **URL**: https://github.com/Michaelliv/pi-dynamic-workflows/
- **Pattern**: Script mode (prototype)
- **Target**: pi subagents

## Mix script+LLM
Model writes small JS script → `workflow` tool runs it in sandbox → script calls `agent/parallel/pipeline` → each spawns in-memory pi subagent → snapshots stream back → final structured result returned.

## Key features
- AST-validated parser + sandboxed runtime (`src/workflow.ts`)
- `workflow` tool with prompt guidelines, rendering, abort handling
- `WorkflowAgent` in-memory pi subagent runner (`src/agent.ts`)
- **Structured output** — terminating tool backed by TypeBox/JSON Schema. No JSON scraping. (`src/structured-output.ts`)
- `agent(prompt, opts)` returns text or validated object with `opts.schema`
- `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, `budget`

## What's missing (vs QuintinShaw fork)
- No persisted/resumable runs (yet)
- No `/workflows` manager (yet)

## Borrow for ACP
- **Structured output as terminating tool** ← ACP DAG captures step output as raw text. TypeBox-validated output would make `{step.output}` template resolution type-safe.
- **AST-validated script** — skipped per user (no sandboxing needed).
- Cleanest reference architecture for "workflow.ts / workflow-tool.ts / agent.ts / structured-output.ts / display.ts" split.

## Refs
- [Michaelliv/pi-dynamic-workflows README](https://github.com/Michaelliv/pi-dynamic-workflows/)

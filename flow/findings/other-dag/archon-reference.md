# Archon (coleam00) — REFERENCE

- **URL**: https://github.com/coleam00/Archon
- **Stars**: ~17K
- **Pattern**: YAML DAG, deterministic + LLM mixed nodes
- **Status**: REFERENCE — canonical "mixed script+LLM" engine. User's `pi-archon-workflow` extension wraps this.

> "The AI still does the intelligent work — writing code, reasoning about architecture, reviewing changes — but the structure is deterministic and owned by you."

## Mixed node types (THE pattern user referenced)
```yaml
nodes:
  - id: plan          # AI node
    prompt: "..."
  - id: tests         # deterministic node
    bash: "npm test"
  - id: review        # AI node
    depends_on: [implement]
    command: smart-review
  - id: loop          # control node
    loop: ...
```

Three node kinds in one DAG:
- **AI node** (`prompt:`) — LLM does the thinking
- **Deterministic node** (`bash:`) — script runs, no model
- **Control node** (`loop:`, `when:`, `trigger_rule:`) — routing

## Key features
- **YAML DAG** — `nodes:` with `id` / `depends_on` / `command` / `prompt` / `bash` / `loop`
- **Topological layering** — `Promise.allSettled` per wave ← ACP DAG has this
- **Worktree isolation** per run ← cross-ref G-F
- **Inline sub-agents in YAML** — no separate `.claude/agents/*.md` needed
- **Trigger rules** — `when:` conditions, `trigger_rule` for skip-propagation
- **Multi-model per node** — `agent:` field controls which model per step
- **Cross-surface** — CLI, Web UI, Slack, Telegram, Discord, GitHub
- **19 default workflows** — archon-fix-github-issue, archon-idea-to-pr, archon-piv-loop, archon-adversarial-dev, etc.

## Borrow for ACP (highest-value reference)
- **Mixed node types** (`bash:` + `prompt:` in same DAG) ← ACP DAG has only LLM-agent steps. **No deterministic `bash` step type.** Biggest gap vs Archon.
- **`when:` conditional routing** ← ACP DAG has no conditional edges. All `dependsOn` are unconditional.
- **`trigger_rule` skip-propagation** ← ACP DAG has no skip semantics.
- **Inline sub-agents in DAG** ← ACP DAG references agent by name only. No inline agent definition.
- **19 default workflows as presets** ← cross-ref G-G predefined teams.

## Refs
- [coleam00/Archon README](https://github.com/coleam00/Archon)
- [Authoring Workflows guide](https://archon.diy/guides/authoring-workflows/)
- [Dev-Ore review](https://www.dev-ore.com/blog/archon-yaml-workflow-engine-ai-coding-agents/)
- [andrew.ooo review](https://andrew.ooo/posts/archon-ai-coding-workflow-engine-review/)

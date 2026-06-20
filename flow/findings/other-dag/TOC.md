# DAG / Workflow Plugins — Findings TOC + Matrix

> Survey of pi ecosystem DAG/workflow extensions + Archon reference.
> Created 2026-06-20. Excludes sandboxing/AST-validation columns (not needed for ACP).
> All 10 pi extensions target **pi subagents** — only ACP DAG runs over external ACP agents.

## Findings index

| File | Repo | Pattern |
|---|---|---|
| [pi-taskflow.md](./pi-taskflow.md) | heggria/pi-taskflow | Declarative JSON DAG |
| [pi-flows.md](./pi-flows.md) | ChicK00o/pi-flows | YAML DAG + live TUI |
| [pi-loom.md](./pi-loom.md) | betaHi/pi-loom | Script mode (Claude Code port) |
| [pi-dynamic-workflows-quintinshaw.md](./pi-dynamic-workflows-quintinshaw.md) | QuintinShaw/pi-dynamic-workflows | Script mode + worktree + budget |
| [pi-dynamic-workflows-michaelliv.md](./pi-dynamic-workflows-michaelliv.md) | Michaelliv/pi-dynamic-workflows | Script mode (prototype) |
| [pi-workflows-umutbasal.md](./pi-workflows-umutbasal.md) | umutbasal/pi-workflows | Script mode, multi-dir discovery |
| [pi-workflow-engine-timbrinded.md](./pi-workflow-engine-timbrinded.md) | timbrinded/pi-workflow-engine | Procedures + TypeBox handoffs |
| [dorkestrator.md](./dorkestrator.md) | sandalsoft/dorkestrator | Lifecycle engine + YAML swarm |
| [agent-pi-ruizrica.md](./agent-pi-ruizrica.md) | ruizrica/agent-pi | Extension suite, 6 modes |
| [pi-agent-flywheel.md](./pi-agent-flywheel.md) | burningportra/pi-agent-flywheel | Beads + multi-model planning |
| [archon-reference.md](./archon-reference.md) | coleam00/Archon | **REFERENCE** — YAML mixed nodes |

## Matrix — feature comparison

Legend: ✅ yes · ⚠️ partial · ❌ no · ➖ n/a

| Repo | Pattern | Mixed bash+LLM nodes | Wave/parallel exec | Resume/journal | Human gates | Typed handoffs | Budget cap | Worktree iso | Live TUI | Conditional routing | Multi-model per step | Runtime sub-DAG gen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **ACP DAG (ours)** | Declarative JSON | ❌ LLM-only | ✅ | ⚠️ resume spec, no journal | ❌ | ❌ raw text | ❌ | ❌ | ❌ (planned: acp-dag-widget) | ❌ | ⚠️ per-agent | ❌ |
| pi-taskflow | Declarative JSON | ❌ LLM-only | ✅ | ✅ phase-by-phase | ✅ approvals | ❌ | ✅ spend ceiling | ❌ | ⚠️ DAG IS the view | ⚠️ gates | ➖ | ✅ validated sub-flow |
| pi-flows | YAML DAG | ❌ LLM-only | ✅ | ⚠️ | ❌ | ❌ templates | ❌ | ❌ | ✅ live dashboard | ✅ auto-routing forks | ✅ role tiers | ❌ |
| pi-loom | Script mode | ⚠️ script+agent() | ✅ parallel | ✅ journal prefix | ❌ | ⚠️ script vars | ❌ | ❌ | ⚠️ snapshots | ✅ code branches | ➖ | ✅ script-authored |
| QShaW dynamic-wf | Script mode | ⚠️ script+agent() | ✅ 16/1000 | ✅ journaled | ✅ checkpoint | ✅ schema | ✅ real-token | ✅ per-agent | ✅ /workflows | ✅ code | ✅ tier/exact | ✅ |
| MichLiv dynamic-wf | Script mode | ⚠️ script+agent() | ✅ parallel | ❌ prototype | ❌ | ✅ TypeBox | ✅ budget | ❌ | ⚠️ snapshots | ✅ code | ➖ | ✅ |
| umutbasal workflows | Script mode | ⚠️ script+agent() | ✅ pipeline | ✅ .runs/ | ❌ | ✅ JSON schema | ❌ | ❌ | ⚠️ phase() | ✅ code | ➖ | ✅ |
| timbrinded wf-engine | Script mode | ⚠️ script+agent() | ✅ cap | ⚠️ | ⚠️ dynamax | ✅ TypeBox | ❌ | ❌ | ✅ inspector | ✅ code | ➖ | ✅ inline |
| dorkestrator | Lifecycle + YAML | ❌ LLM-only | ✅ waves | ⚠️ event-sourced | ✅ review phase | ⚠️ SharedContext | ❌ | ❌ | ⚠️ dork-status | ⚠️ waits_for | ➖ | ❌ |
| agent-pi | YAML suite | ❌ LLM-only | ✅ pipeline | ⚠️ | ✅ review | ⚠️ $INPUT | ❌ | ❌ | ✅ subagent-widget | ⚠️ modes | ➖ | ❌ |
| pi-agent-flywheel | Beads + multi-plan | ❌ LLM-only | ✅ swarm | ⚠️ memory | ✅ review gates | ⚠️ br tasks | ❌ | ✅ ntm | ✅ ntm panes | ⚠️ | ✅ multi-model plan | ❌ |
| **Archon (REF)** | YAML DAG | **✅ bash+prompt+loop** | ✅ allSettled | ✅ durable | ✅ interactive | ⚠️ artifacts | ❌ | ✅ per-run | ⚠️ | **✅ when:/trigger_rule** | ✅ per-node agent | ❌ |

## Camp split

| Camp | Shape | Repos |
|---|---|---|
| **Declarative DAG** (graph IS data) | JSON/YAML graph, verified before run | ACP DAG, pi-taskflow, pi-flows, dorkestrator, **Archon** |
| **Script mode** (code = control flow) | JS in runtime, `agent()` is LLM | pi-loom, QShaW/MichLiv dynamic-wf, umutbasal, timbrinded |

## ACP DAG gaps surfaced (vs ecosystem)

Ranked by gap severity:

1. **No `bash` deterministic node** ← only Archon has this. Biggest "mixed script+LLM" gap.
2. **No conditional routing (`when:`/`trigger_rule`)** ← Archon, pi-loom, QShaW all have.
3. **No human approval gates** ← QShaW checkpoint, pi-taskflow approvals, dorkestrator review, flywheel gates.
4. **No typed handoffs** ← QShaW/MichLiv/timbrinded use TypeBox. ACP = raw text templates.
5. **No token budget cap** ← pi-taskflow spend ceiling, QShaW real-token tracker.
6. **No worktree isolation** ← QShaW per-agent, Archon per-run, flywheel ntm. (Cross-ref G-F deferred.)
7. **No live TUI** ← pi-flows dashboard, QShaW /workflows, agent-pi subagent-widget, flywheel ntm. (Cross-ref acp-dag-widget change.)
8. **No multi-model planning** ← flywheel parallel planners synthesize. ACP = single submitter.
9. **No runtime sub-DAG generation** ← pi-taskflow validated sub-flow, pi-loom script-authored.
10. **No lifecycle phases (interview/plan/review)** ← dorkestrator event-sourced FSM.

## Callsouts

**[CA1]**: All 10 pi extensions target **pi subagents**. **None** target ACP (external CLI agents). ACP DAG is the only one — differentiator is real.

**[CA2]**: Closest sibling to ACP DAG = **pi-taskflow** (same declarative JSON shape, same static validation). Borrow: spend ceiling, validated runtime sub-flow, saveable commands.

**[CA3]**: For "mixed script+LLM" specifically (Archon pattern), **no pi extension fully matches** — they're either pure-DAG or pure-script. Archon is the only one mixing `bash:` + `prompt:` + `loop:` nodes in one DAG. If ACP DAG v2 adds `bash:` step type → only ACP + Archon do this.

**[CA4]**: Sandboxing/AST-validation columns intentionally excluded per user. (pi-loom, MichLiv, QShaW all do `node:vm` sandbox — not relevant to ACP since ACP agents are external processes.)

**Assumptions [A]**: Did not clone/audit source of all 11 repos — relied on README highlights + reviews. Feature matrix reflects documented capabilities, not verified behavior. Star counts approximate.

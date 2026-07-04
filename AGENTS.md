<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pi-acp-agents** (2372 symbols, 5486 relationships, 161 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pi-acp-agents/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pi-acp-agents/clusters` | All functional areas |
| `gitnexus://repo/pi-acp-agents/processes` | All execution flows |
| `gitnexus://repo/pi-acp-agents/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Agent profiles vs servers

`agent_servers.<key>` is an **agent profile**: a named persona (`systemPrompt` + narrower goal + optional `default_model`/`default_mode` + optional `description`) that *references* a **server** (the transport: `command` + `args` + `env` + `cwd`). Multiple profiles MAY share one server binary — e.g. `pi`, `verifier`, `coder`, `browser-tester`, `red`, `general` all back onto `pi-acp` but each carries its own persona.

The optional `description?: string` field surfaces a one-line summary of what the profile does and when to use it. It appears in `/acp agents`, `acp_status`, `acp_runtime_info`, `acp_doctor`, and the agent-config TUI. Absent → `(no description)` placeholder. Non-string values are rejected by `validateConfig`.

Canonical example: [`docs/agent-profiles-example.json`](docs/agent-profiles-example.json).

### The 7 canonical aliases

| Alias | Server | Description |
|-------|--------|-------------|
| `claude` | `npx @agentclientprotocol/claude-agent-acp` | Claude Code via the official ACP adapter — general-purpose coding agent. |
| `pi` | `pi-acp` | Default pi coding agent — the workhorse for repo-local dev tasks. |
| `verifier` | `pi-acp` | Blind reviewer persona — gates work via the verifier-loop (≥2 unanimous approvals). |
| `coder` | `pi-acp` | Implementation-focused persona — writes GREEN-phase code from RED tests / plans. |
| `browser-tester` | `pi-acp` | E2E/browser persona — drives the abw skill for UI/UX verification. |
| `red` | `pi-acp` | Adversarial/red-team persona — finds edge cases, breaks assumptions, stress-tests designs. |
| `general` | `pi-acp` | Unscoped general assistant — inherits the global pi system prompt, no narrowed goal. |


## ACP Tools — State Manifest

**Before touching any ACP tool**: read [`flow/plans/manifest/state.md`](flow/plans/manifest/state.md) — single source of truth for which tools are `implemented` / `partial` / `stub` / `planned` / `deferred` / `to-sunset`, with gap + plan references. Active registered tools = 13 (audit `index.ts registerTool`). `src/settings/config.ts ACP_TOOL_NAMES` is a legacy list (39) and misleading.

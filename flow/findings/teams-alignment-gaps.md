# Findings: Teams vs ACP Alignment Gaps

Date: 2026-06-12
Status: ACTIVE

## Gap 1: Tool Policy — No Wildcard/Regex Support

**Source**: `~/.pi/agent/git/github.com/buihongduc132/pi-agent-teams/extensions/teams/leader.ts` lines 42–73

```ts
const tools = new Set([...policy.baseline, ...policy.extra]);
for (const d of policy.denied) tools.delete(d);
```

**Problem**: `teams-tool-policy.json` requires **exact string match** per tool name. No wildcard, no regex, no glob.

**Impact**: Every `hindsight_*` and `gitnexus_*` variant must be listed individually. When new tools are added (e.g. `gitnexus_new_tool`), the JSON must be manually updated or the tool is invisible to workers.

**Current workaround**: All 12 hindsight/gitnexus tools listed explicitly in `extra[]`.

**Fix needed**: Support wildcard patterns like `hindsight_*`, `gitnexus_*`, `email_*` in `baseline`, `extra`, and `denied` arrays. Match against the pi tool registry at resolution time.

**Location in pi-plugins**: `.pi/agents/` — all agents rely on this policy for Path B tool access.
**Location in pi-agent-teams**: `extensions/teams/leader.ts` → `readToolPolicy()`

---

## Gap 2: Tool Policy — No Caching

**Source**: Same as Gap 1 — `readToolPolicy()` reads and parses `teams-tool-policy.json` on every spawn.

**Problem**: No in-memory cache. Every teammate spawn:
1. Checks `fs.existsSync(policyPath)`
2. Reads file from disk
3. Parses JSON
4. Validates each field
5. Builds `Set<string>`

**Impact**: On a 5-agent team with 10 tasks, this runs 50+ times. Not catastrophic but wasteful. If the policy file is corrupted mid-session, a previously-working spawn suddenly fails.

**Fix needed**: Cache the parsed `Set<string>` in memory. Invalidate on file change (fs.watch or mtime check).

---

## Gap 3: Teams ↔ ACP — No Shared Agent Definitions

**Teams side** (pi-plugins): `.pi/agents/*.md` — 31 agent frontmatter files with name, model, tools.
**ACP side** (pi-acp-agents): Agents configured in `settings.json` → `agents` key or `acpx.yaml`.

**Problem**: Two completely separate agent registries. A "verifier-1" defined in `.pi/agents/verifier-1.md` has no corresponding ACP agent definition. The ACP system doesn't know about teams roles at all.

**Impact**:
- Cannot delegate a task to a "verifier-1" role via ACP — only via teams `delegate`
- Cannot use ACP DAG workflows with teams-defined agents
- Model routing (`rag-long`) defined in teams agent files is invisible to ACP

**Reference**: `../pi-acp-agents/flow/intentions/acp-dag-delegation.md` — DAG delegation requires agent assignment per step, but agents are ACP-configured, not teams-configured.

---

## Gap 4: Teams ↔ ACP — No Shared Task Model

**Teams tasks**: `teams({ action: "delegate" })` → in-memory task list with status, assignee, dependencies.
**ACP tasks**: `AcpTaskStore` → JSON-backed task records with `blockedBy`/`blocks` edges, DFS cycle detection, `claimNextAvailable()`.

**Problem**: Two independent task stores. A task created via teams is invisible to `acp_task_list`. A task created via ACP is invisible to `teams({ action: "task_assign" })`.

**Impact**:
- Secretary agent tracking progress across both systems must query both
- No unified DAG view — teams tasks and ACP tasks cannot depend on each other
- Changes-track agent must check two separate stores for branch/worktree state

**Reference**: `../pi-acp-agents/flow/intentions/multi-agent-dag-coordination.md` — GAP-1 through GAP-4 identified but no resolution path to teams integration.

---

## Gap 5: Guard Team — No Guard-orches Awareness

**Teams side**: `.pi/agents/guard-*.md` — 5 agents (guard-cmem, guard-coding, guard-mutator, guard-nexus, guard-ui-a11y).
**Guard-orches side**: `../guard-orches/components/` — actual guard implementations with AST rules, mutation tests, codeql configs.

**Problem**: The guard agents in teams are **1-line descriptions** pointing at the component directory. They have no:
- Knowledge of what rules exist in each guard component
- Awareness of scan results (e.g. `scan-pi-*.txt` files in guard-orches root)
- Ability to run guard checks (no guard-specific tools or scripts exposed)
- Config for guard-orches-specific tool access

**Impact**: When spawned as a team member, a guard agent would need to discover guard-orches structure from scratch every time. No persistent awareness of what was already checked.

**Reference**: `../guard-orches/` — has `_GOAL_guard_ui.md`, `_GOAL_pi_plugins.md`, `reports/`, `scripts/` but none wired to guard team agents.

---

## Gap 6: TDD Team — No Red/Green/Refactor Tool Constraints

**Teams side**: `.pi/agents/tdd-red.md`, `tdd-green.md`, `tdd-refactor.md` — each has a 1-line instruction.
**Problem**: No tool-level enforcement:
- `tdd-red` should ONLY write test files but has full `edit`/`write` access
- `tdd-green` should ONLY write implementation files but could write tests too
- `tdd-refactor` should ONLY modify existing code but could create new files

**Impact**: The TDD discipline relies entirely on the LLM following the instruction. No structural guard prevents a "red" agent from writing implementation code.

**Fix needed**: Per-role tool restrictions or file-path restrictions (e.g. `tdd-red` can only write to `*.test.ts` / `*.spec.ts` files).

---

## Gap 7: Secretary/Compliance/Changes-Track — No Persistent State

**Problem**: These governance agents have no dedicated storage for their tracking data:
- **Secretary**: No durable progress log. State lost between spawns.
- **Compliance**: No violation registry. Cannot accumulate compliance issues across tasks.
- **Changes-track**: No branch/worktree/stash inventory. Must rediscover every spawn.

**Impact**: Every time these agents are spawned, they start from zero. No memory of what was previously tracked, what violations were found, or what branches exist.

**Fix needed**: Dedicated JSON/SQLite stores per governance agent, or shared `flow/` directory for persistent state.

---

## Summary Matrix

| Gap | Severity | System | Fix Location |
|-----|----------|--------|-------------|
| G1: No wildcard in tool policy | MEDIUM | pi-agent-teams | `leader.ts` `readToolPolicy()` |
| G2: No caching of tool policy | LOW | pi-agent-teams | `leader.ts` `readToolPolicy()` |
| G3: No shared agent definitions | HIGH | teams ↔ ACP | Bridge layer needed |
| G4: No shared task model | HIGH | teams ↔ ACP | Unified task store needed |
| G5: Guard agents have no guard awareness | MEDIUM | guard team | Wire guard-orches tools |
| G6: TDD roles have no tool constraints | MEDIUM | TDD team | Per-role tool restrictions |
| G7: Governance agents have no persistent state | MEDIUM | secretary/compliance/changes-track | Dedicated storage |

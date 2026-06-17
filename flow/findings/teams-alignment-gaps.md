# Findings: Teams vs ACP Alignment Gaps

Date: 2026-06-12 (expanded 2026-06-17)
Status: ACTIVE — single source of truth for ACP-vs-Teams feature deltas.

> **Purpose**: Each gap below pairs (a) the **detailed pi-agent-teams behavior** (with source citations) against (b) the **current pi-acp-agents state**, then maps to a plan in `flow/plans/`. When a plan references this file, the gap ID (e.g. `G-A`) MUST resolve to one of these sections.

## Source repos

- **teams**: `~/.pi/agent/git/github.com/buihongduc132/pi-agent-teams/extensions/teams/` (referred to below as `teams/<file>`)
- **acp**: this repo, `src/` + `index.ts` + `packages/pi-acp-advanced/`

---

## G-A — Persistent named workers / `member_spawn`

### Teams behavior (detailed)

A "teammate" is a **long-lived, named, RPC-addressable worker process** with stable identity:

- **Identity**: `PI_TEAMS_TEAM_ID` + `PI_TEAMS_AGENT_NAME` env vars bootstrap a worker (`teams/worker.ts:44-71`). The worker reads team dir, task list, lead name, style, and `autoClaim` flag at startup.
- **Worker loop** (`teams/worker.ts:runWorker`): after bootstrap, the worker runs a loop that:
  1. Calls `claimNextAvailableTask()` (`teams/task-store.ts:787`) to grab the next unassigned, unblocked, non-completed task.
  2. Builds a task prompt via `buildTaskPrompt()` and runs the pi agent on it.
  3. On completion, marks task done and **re-loops** to claim the next one.
  4. Auto-claim is on by default (`PI_TEAMS_DEFAULT_AUTO_CLAIM=1`); disable with `PI_TEAMS_AUTO_CLAIM=0`.
- **Lifecycle**: leader spawns (`teams/leader-spawn-command.ts`, `member_spawn` action) → worker heartbeats (`teams/heartbeat-lease.ts`) → leader tracks online/idle/streaming (`teams/leader-teams-tool.ts` widget) → graceful `member_shutdown` handshake or force `member_kill`.
- **Steering while alive**: the leader holds a `TeammateRpc` handle (`teams/teammate-rpc.ts`) per live worker; `rpc.steer(msg)` injects an instruction into the running agent turn.
- **Hooks on lifecycle**: worker emits events (`teams/hooks.ts`) the leader can gate on.

### ACP state

- `WorkerStore` (`src/management/worker-store.ts`) exists with `register/assignTask/updateStatus` but is **dead code** — `AgentCoordinator.delegate()` and `AsyncExecutor.start()` never consult it, and it is **not registered as a tool**. Confirmed in `flow/intentions/multi-agent-dag-coordination.md` ("WorkerStore exists but not connected").
- ACP `delegate`/`session_new` always create **short-lived isolated** subprocesses disposed after one response. There is no persistent worker identity, no claim loop, no live RPC handle.

### Delta

No `acp_worker_spawn`, no claim loop, no long-lived named workers. The `WorkerStore` + `claimNextAvailable` primitives exist but are unwired.

**Plan**: `flow/plans/persistent-acp-workers.md` (new). Also referenced by `flow/intentions/multi-agent-dag-coordination.md` GAP-1.

---

## G-B — Live steer injection into a running agent

### Teams behavior (detailed)

- `message_steer` action (`teams/leader-teams-tool.ts:457-474`) requires `name` + `message`, looks up the live `TeammateRpc` for that worker, and calls `rpc.steer(message)` (`teams/teammate-rpc.ts:213-214`).
- The steer message is sent as an RPC envelope `{ id, type: "steer", message }` (`teams/teammate-rpc.ts:19`) into the **active agent turn** — the running pi agent receives it mid-work and can adjust behavior immediately. It is **active injection**, not a queued note.
- DMs/broadcasts, by contrast, write to file-based mailboxes for later polling.

### ACP state

- `acp_message` with `kind:"steer"` is accepted but `MailboxManager.send()` (`src/management/mailbox-manager.ts:12`) only **persists a mailbox record**. There is no bridge from that record back into an active ACP session's prompt stream. Effectively a passive write with no consumer.

### Delta

Steer is a no-op pass-through today; needs an active-injection path into a running session (see G-A workers) or a session-level `sessionInject` ACP message.

**Plan**: `flow/plans/persistent-acp-workers.md` (steer requires live workers from G-A).

---

## G-C — Auto-claim background loop

### Teams behavior (detailed)

- `claimNextAvailableTask()` (`teams/task-store.ts:787`) picks the next task whose dependencies are satisfied and which is unassigned/non-completed.
- The worker loop (`teams/worker.ts`) calls it repeatedly; idle workers self-dispatch with **no leader intervention**. Controlled by `PI_TEAMS_DEFAULT_AUTO_CLAIM` (default `1`).
- Leader-side `/team attach --claim` (`teams/team-attach-claim.ts`) lets a session adopt an existing team and join the claim pool.

### ACP state

- `AcpTaskStore.claimNextAvailable()` exists (per the DAG intention) but **no background dispatcher drives it**. Tasks created via `acp_task_create` sit until a human or LLM manually assigns + delegates.

### Delta

No autonomous worker pool. Needs G-A workers + a dispatcher loop.

**Plan**: `flow/plans/persistent-acp-workers.md`.

---

## G-D — Hooks / quality-gate policy

### Teams behavior (detailed)

- Hook system: `teams/hooks.ts`. Events fire on idle / task-completion (configurable). `resolveHookCommand()` discovers an executable by event name (`.sh`/`.ps1`/`.js`/`.mjs`/binary) in `getTeamsHooksDir()`.
- Hook invocation (`runTeamsHook`) spawns the resolved command with a rich env: `PI_TEAMS_HOOK_EVENT`, `PI_TEAMS_TEAM_ID`, `PI_TEAMS_TEAM_DIR`, `PI_TEAMS_TASK_*`, `PI_TEAMS_MEMBER`, `PI_TEAMS_EVENT_TIMESTAMP`, and a `PI_TEAMS_HOOK_CONTEXT_JSON` blob.
- **Failure policy** (`TeamsHookFailureAction`, `teams/hooks.ts:58`): `warn | followup | reopen | reopen_followup`. Leader tools `hooks_policy_get` / `hooks_policy_set` expose `hookFailureAction`, `hookMaxReopensPerTask`, `hookFollowupOwner` at runtime (with `hooksPolicyReset` to clear overrides).
- `requiresFollowup()` / `requiresReopen()` (`teams/hooks.ts:78,82`) decide post-hook behavior.

### ACP state

- **No concept.** No `acp_hooks_*` tools, no hook policy store, no event→command resolution. The closest thing is `acp_doctor` (a liveness check), which is not a hook.

### Delta

Entirely missing. Needs an ACP-native hook layer (per-session/per-task events → commands) plus policy.

**Plan**: `flow/plans/acp-hooks-quality-gates.md` (new).

---

## G-E — Session context branching (`contextMode: branch`)

### Teams behavior (detailed)

- `ContextMode = "fresh" | "branch"` (`teams/spawn-types.ts:4`). `branch` clones the leader's conversation branch into the teammate session so it starts with full awareness of prior work.
- Exposed on `delegate` and `member_spawn` (`contextMode` field in the `teams` tool schema).

### ACP state

- `acp_delegate` / `acp_session_new` always start **fresh isolated** sessions. There is no fork of the parent pi session's context into an ACP subprocess. ACP transport (JSON-RPC over stdio) has no native context-forking primitive.

### Delta

No context inheritance. Would require either: (a) replaying parent messages into the new session as a prompt, or (b) a provider-specific context-fork API.

**Plan**: `flow/plans/acp-context-branching.md` (new). Lower priority — ACP agents are external processes so this is non-trivial.

---

## G-F — Git worktree isolation (`workspaceMode: worktree`)

### Teams behavior (detailed)

- `WorkspaceMode = "shared" | "worktree"` (`teams/spawn-types.ts:5`). `worktree` provisions a `git worktree` + branch per teammate (`teams/worktree.ts`) so workers edit isolated branches without conflicting writes.
- `inspectGitWorktree()` / worktree listing (`teams/worktree.ts:203`) support teardown and status checks.

### ACP state

- ACP agents run in a shared `cwd` (passed via `cwd` param). No per-agent worktree provisioning, no branch-per-agent isolation.

### Delta

No workspace isolation. Would pair with G-E for spawn-time setup.

**Plan**: `flow/plans/acp-workspace-isolation.md` (new). Pairs with G-E.

---

## G-G — Predefined teams / agent presets

### Teams behavior (detailed)

- `teams/predefined/` directory holds named team presets. Tools `predefined_teams_list`, `predefined_agents_list`, `predefined_team_spawn` (`teams/predefined-agent-spawn.ts`) let the LLM discover and one-shot spawn a whole team or single agent from a preset.
- Presets carry model/tools/init-prompt so the agent starts configured.

### ACP state

- No preset catalog. Agents are defined only in `config.json` `agent_servers`. No notion of a reusable multi-agent team bundle.

### Delta

No presets / no team bundle. Closest existing intent is the **Workflow Templates** extension (`flow/intentions/acp-workflow-templating.md`) but that templates *workflows*, not *agent rosters*.

**Plan**: fold into `flow/intentions/acp-workflow-templating.md` (Extension 2) + add an agent-preset section. See mapping table below.

---

## G-H — Team styles / naming system

### Teams behavior (detailed)

- `teams/teams-style.ts` + `teams/names.ts`. Built-in styles normal/soviet/pirate with `memberTitle`/`memberPrefix`, lifecycle verbs (`killedVerb`, `shutdownRequestedVerb`, …), and auto-name pools (`autoNameStrategy: { kind: "pool", pool: [...] }`).
- Custom styles via `~/.pi/agent/teams/_styles/<style>.json` extending a base. `requireExplicitSpawnName` toggles whether spawn must name the worker.

### ACP state

- Only `session_name` (free string). No style system, no auto-naming.

### Delta

Minor. Mostly cosmetic. **Defer** unless agent rosters (G-G) need it.

**Plan**: defer (note in `flow/plans/acp-workspace-isolation.md` follow-ups).

---

## G-I — `task_dep_ls` (per-task dependency inspection)

### Teams behavior

Dedicated `task_dep_ls` action to inspect one task's block graph.

### ACP state

`acp_task_get` returns dependency state; `acp_task_dependency_add/remove` exist. No dedicated list-inspection tool, but `acp_task_get` covers the data.

### Delta

Trivial. **Already covered** by `acp_task_get`. No new plan.

---

## G-J — Worker heartbeat / staleness detection

### Teams behavior (detailed)

- `teams/heartbeat-lease.ts` + worker heartbeat config (`getWorkerHeartbeatConfig`, gated by `PI_TEAMS_HEARTBEATS=1`). Workers write heartbeats; leader marks stale when leases expire (visible as "stale worker heartbeats" in the teams widget).
- `teams/activity-tracker.ts` + `adaptive-polling.ts` drive online/idle/streaming status.
- Task leases (`PI_TEAMS_TASK_LEASES=1`) prevent two workers claiming the same task.

### ACP state

- `HealthMonitor` (`src/core/health-monitor.ts`) does **session** health (lastResponseAt / completedAt auto-close). `deferred-openclaw-heartbeat-for-dag.md` covers **DAG-step** liveness. **Neither** covers persistent-worker liveness for long-lived agents (G-A workers).

### Delta

Worker-liveness layer needed once G-A lands.

**Plan**: `flow/plans/persistent-acp-workers.md` (heartbeat requirement). Distinct from `deferred-openclaw-heartbeat-for-dag.md` (which is DAG-step-scoped).

---

## G-K — Team-wide teardown / graceful handshake shutdown

### Teams behavior (detailed)

- `member_shutdown` (`teams/leader-teams-tool.ts`) sends a graceful request over RPC; the worker finishes its turn, persists state, acks. `member_shutdown all=true` rolls through all workers. `member_prune` marks stale non-RPC workers offline. `teams/cleanup.ts` tears down all artifacts (tasks, mailboxes, sessions, worktrees).

### ACP state

- `acp_session_shutdown` disposes per-session or per-agent; `acp_cleanup` wipes runtime state. **No handshake** — just SIGTERM→SIGKILL dispose. No graceful "finish turn then exit" semantics.

### Delta

Needs handshake protocol (ties into G-A RPC). Lower severity.

**Plan**: `flow/plans/persistent-acp-workers.md` (graceful-shutdown requirement).

---

## Cross-cutting gaps (both systems)

### G1 — Tool policy wildcard/regex
**teams**: `leader.ts:42-73` `readToolPolicy()` — exact string match only. Every `hindsight_*`/`gitnexus_*` variant listed individually.
**acp**: N/A (ACP agents define their own tool access).
**Severity**: MEDIUM. **Plan**: teams-side fix, not in pi-acp-agents scope. Tracked here for cross-reference only.

### G2 — Tool policy caching
**teams**: `readToolPolicy()` re-reads/parses JSON every spawn. No cache.
**Severity**: LOW. **Plan**: teams-side fix.

### G3 — Shared agent definitions (teams ↔ ACP)
**teams**: `.pi/agents/*.md` frontmatter (name, model, tools) — 31 files.
**acp**: `config.json` `agent_servers` / `acpx.yaml`.
**Delta**: Two registries. A "verifier-1" in `.pi/agents/` is invisible to ACP `delegate`. Model routing in agent files is invisible to ACP.
**Severity**: HIGH. **Plan**: `flow/plans/teams-acp-shared-registry.md` (new bridge).

### G4 — Shared task model (teams ↔ ACP)
**teams**: in-memory task list (pending/in-progress/completed + deps) via `delegate`/`task_*`.
**acp**: `AcpTaskStore` (JSON-backed, `blockedBy`/`blocks`, DFS cycle detection, `claimNextAvailable`).
**Delta**: Two stores. Teams tasks invisible to `acp_task_list` and vice versa. No unified DAG view.
**Severity**: HIGH. **Plan**: `flow/plans/teams-acp-shared-registry.md` (unified task store).

### G5 — Guard agents have no guard-orches awareness
Guard agents are 1-line descriptions; no knowledge of guard-orches rules/scan results.
**Severity**: MEDIUM. Domain-specific. **Plan**: out of pi-acp-agents scope.

### G6 — TDD roles have no tool/path constraints
`tdd-red` should only write tests; no tool-level enforcement.
**Severity**: MEDIUM. **Plan**: ties to G-D hooks (per-role tool restrictions).

### G7 — Governance agents have no persistent state
Secretary/compliance/changes-track lose state between spawns.
**Severity**: MEDIUM. **Plan**: ties to G-A persistent workers + dedicated stores.

---

## Summary Matrix

**Priority order** (set 2026-06-17 by user):
1. `persistent-acp-workers.md` (G-A/B/C/J/K) — highest
2. `acp-per-agent-cooldown.md` — high (just after #1)
3. `acp-hooks-quality-gates.md` (G-D)
4. `acp-context-branching.md` (G-E) — keep
5. ~~`acp-workspace-isolation.md` (G-F)~~ — **DEFERRED**
6. ~~`teams-acp-shared-registry.md` (G3/G4)~~ — **DEFERRED**

| Gap | Severity | System | Plan (file) | Status |
|-----|----------|--------|-------------|--------|
| G-A persistent named workers | **HIGH** | ACP | `persistent-acp-workers.md` | PRI-1 |
| G-B live steer | **HIGH** | ACP | `persistent-acp-workers.md` | PRI-1 |
| G-C auto-claim loop | **HIGH** | ACP | `persistent-acp-workers.md` | PRI-1 |
| G-D hooks / quality-gate policy | **HIGH** | ACP | `acp-hooks-quality-gates.md` | PRI-3 |
| G-E context branching | MEDIUM | ACP | `acp-context-branching.md` | PRI-4 |
| G-F worktree isolation | MEDIUM | ACP | `acp-workspace-isolation.md` | **DEFERRED** |
| G-G predefined teams/presets | MEDIUM | ACP | fold into `acp-workflow-templating.md` | deferred |
| G-H styles/naming | LOW | ACP | — | defer |
| G-I task_dep_ls | LOW | ACP | covered by `acp_task_get` | n/a |
| G-J worker heartbeat | **HIGH** | ACP | `persistent-acp-workers.md` | PRI-1 |
| G-K graceful handshake shutdown | MEDIUM | ACP | `persistent-acp-workers.md` | PRI-1 |
| cooldown (user req #2) | **HIGH** | ACP | `acp-per-agent-cooldown.md` | PRI-2 |
| G1 tool policy wildcard | MEDIUM | teams | teams-side | out of scope |
| G2 tool policy caching | LOW | teams | teams-side | out of scope |
| G3 shared agent definitions | **HIGH** | bridge | `teams-acp-shared-registry.md` | **DEFERRED** |
| G4 shared task model | **HIGH** | bridge | `teams-acp-shared-registry.md` | **DEFERRED** |
| G5 guard agent awareness | MEDIUM | guard | — | out of scope |
| G6 TDD tool constraints | MEDIUM | ACP | ties to G-D hooks | PRI-3 |
| G7 governance persistent state | MEDIUM | ACP | ties to G-A workers | PRI-1 |

---

## Status-line liveliness requirement (LIVELINESS-1)

> **Applies to**: any plan that creates a persistent/long-lived ACP worker or session that the user monitors (G-A, G-J, G-K, and the cooldown plan's status surface).

**Requirement**: The ACP status line (per-session and per-worker) MUST surface **live counters** so a human can distinguish "still working" from "hung":

1. **Token count** — cumulative input+output tokens consumed by the session/worker since spawn. Source: ACP `session/update` events (`tokensIn`/`tokensOut` cumulative fields) or per-prompt deltas if cumulative is unavailable.
2. **Tool-call count** — number of tool invocations made by the session/worker since spawn. Source: ACP `session/update` `toolCall`/progress events.
3. **Last-activity age** — time since the last `session/update` of any kind (token delta, tool call, or text). This is the hang detector: if token count, tool-call count, AND last-activity age are all frozen, the worker is hung.
4. **Display contract**: the widget/status row must show `tok=<n> · tools=<n> · <age>s ago` so the three signals are readable at a glance. If all three are stale beyond `stallTimeoutMs`, render a `⚠ stale` indicator.

**Why**: ACP agents are external processes. Without token/tool-call movement, a silent session is indistinguishable from a crashed one. The teams widget already infers this from heartbeats; ACP should show the underlying counters directly.

**Non-goals**: cost estimation, per-model token rates. Just raw movement counters for liveliness.

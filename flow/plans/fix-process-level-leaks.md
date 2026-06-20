# Fix Process-Level Leaks (G1–G4)

Least-resistance, YAGNI, DRY plan. No source changes yet — plan only.

## 1. Problem

- **G1** (`index.ts:1756`): `pi.on("session_shutdown", async () => {...})` is async. If pi host does not await the hook, `disposeAll()` is interrupted mid-loop → remaining ACP children orphaned.
- **G2**: pi host killed by SIGKILL/OOM/segfault → `session_shutdown` never fires → **all** spawned agent subprocesses reparent to PID 1.
- **G3** (`circuit-breaker.ts:240–252`): POSIX path uses `proc.kill("SIGTERM")` (single pid). Only the direct child dies. Grandchildren (MCP stdio servers, native helpers the agent spawns) leak. Windows is correct (`taskkill /T /F`).
- **G4** (`circuit-breaker.ts:248–252`): escalation timer uses `timer.unref()`. If the event loop drains before 5s (parent exiting, no other handles), the SIGKILL never fires → a SIGTERM-ignoring agent survives.

## 2. Root cause

Single root cause spans G1/G3/G4: **the kill primitive is process-scoped, not group-scoped, and its escalation timer is allowed to be cancelled by event-loop drain.** G2 is a separate, fundamentally-harder class (no opportunity to run cleanup code) and is handled only by a kernel-assisted mechanism, which we deliberately defer.

Concretely:
- `killWithEscalation` targets `proc` (one pid) on POSIX; on Windows it targets the tree (`/T`). The asymmetry leaves the POSIX grandchildren live.
- `timer.unref()` opts the escalation out of keeping the loop alive — correct for steady-state dispose, wrong for the shutdown window where the loop is draining.
- `session_shutdown` is `async` but its sync portion (kill dispatch) is what actually matters. The `await disposeAll()` is decorative if not awaited by pi — the kill already happened synchronously inside `AcpClient.dispose()`, but only to the direct child.

## 3. Solution

Three surgical changes. No rewrites. Reuse `killWithEscalation` everywhere (DRY).

### 3.1 Spawn each agent in its own POSIX process group — `src/core/client.ts` (~line 220)

```ts
this.proc = spawn(cmd, args, {
  cwd: this.cwd,
  env: { ...process.env, ...this.config.env },
  stdio: ["pipe", "pipe", "pipe"],
  shell: platform() === "win32",
  detached: platform() !== "win32", // NEW: child becomes its own process-group leader (pgid === pid)
});
```

`detached: true` + new session = `pgid === proc.pid`. We **do not** call `proc.unref()` — we still want the stdio pipes and exit events. Detached only affects the group/session, not refcounting.

Why: makes the POSIX kill symmetric with the Windows tree kill. Grandchildren inherit the group.

### 3.2 Make `killWithEscalation` group-aware + escalation-tunable — `src/core/circuit-breaker.ts`

New signature (back-compat default preserves all current call sites):

```ts
export interface KillOptions {
  escalationMs?: number; // default 5000
  /** When true, do NOT unref the SIGKILL timer. Use during shutdown. */
  refTimer?: boolean; // default false
}
export function killWithEscalation(proc: ChildProcess, opts: KillOptions = {}): void
```

POSIX body:

```ts
const pgid = proc.pid;
if (pgid == null) return;
const escalate = opts.escalationMs ?? 5000;
const refTimer = opts.refTimer ?? false;

try { process.kill(-pgid, "SIGTERM"); } catch { /* group already dead */ }
const timer = setTimeout(() => {
  try { process.kill(-pgid, "SIGKILL"); } catch { /* dead */ }
}, escalate);
if (!refTimer) timer.unref();
```

Key points:
- `process.kill(-pgid, signal)` targets the **whole process group** (negative pid) — the standard idiom. Grandchildren die.
- `refTimer` is the G4 fix: callers in the shutdown path pass `refTimer: true` so the SIGKILL escalation survives loop drain.
- Windows path is **unchanged** (`taskkill /T /F` already kills the tree).
- No duplicated kill logic — single function.

### 3.3 Defensive shutdown hook + belt-and-suspenders `beforeExit` — `index.ts:1756`

Replace the async hook with a sync, kill-first, best-effort-async body, and add a `process.once("beforeExit")` fallback:

```ts
// SYNC kill-first — works even if pi host doesn't await the hook.
pi.on("session_shutdown", () => {
  monitor.stop();
  workerDispatcher?.stop();
  for (const adapter of activeAdapters.values()) {
    try { adapter.dispose(); } catch { /* best-effort */ }
  }
  activeAdapters.clear();
  busySessions.clear();
  // Best-effort async cleanup; may be interrupted — kills already dispatched above.
  sessionMgr.disposeAll().catch(() => {});
  eventLog.append("session_shutdown_all");
});

// G2 mitigation window: covers clean exit paths where session_shutdown
// might be skipped. NOT a SIGKILL guard (see §6 OOS).
process.once("beforeExit", () => {
  for (const adapter of activeAdapters.values()) {
    try { adapter.dispose(); } catch {}
  }
  activeAdapters.clear();
});
```

`AcpClient.dispose()` (client.ts) already calls `killWithEscalation(this.proc)` synchronously. Change that single call site to pass `{ refTimer: true }` so the SIGKILL escalation cannot be cancelled by loop drain (G4):

```ts
if (this.proc && !this.proc.killed) {
  killWithEscalation(this.proc, { refTimer: true });
}
```

Net diff surface: 3 files (`client.ts`, `circuit-breaker.ts`, `index.ts`), ~15 lines changed.

### 3.4 G2 — documented limitation (no code)

When the parent is SIGKILL'd/OOM'd, `session_shutdown` and `beforeExit` cannot fire. Process-group kill does **not** save us here: the children are in their **own** group (detached), so the kernel does not auto-reap them on parent death. Options we are **explicitly declining** (YAGNI — §6):

- `prctl(PR_SET_PDEATHSIG)` Linux-only native binding
- Companion watchdog / pidfd-poll process
- systemd unit / `KillMode=control-group`

Mitigation in scope: none. Documented in §6 + a note in the module-level comment of `circuit-breaker.ts`.

> **Assumption verification** (the task asked us to verify): "the whole group dies with the parent's session" is **FALSE** for detached groups. The session/controlling-terminal SIGHUP mechanism only fires for foreground process groups attached to a TTY — irrelevant for pi spawned subprocesses with piped stdio. Hence G2 remains an open, documented risk; the group-kill fix (3.2) covers G3 only.

## 4. TDD test cases (vitest)

New file: `test/process-leaks.test.ts`. Assert behavior, not internal layout.

### `killWithEscalation`
1. **POSIX group SIGTERM** — spawn a shell that spawns a sleep grandchild; assert `process.kill(-pgid)` reaches the grandchild (grandchild exit observed). Use a real `sh -c 'sleep 30 & exec sleep 30'`. (Skip on `win32`.)
2. **POSIX group SIGKILL escalation** — spawn `sh -c 'trap "" TERM; sleep 30'` (ignores SIGTERM); assert grandchild/prog dies within `escalationMs + slack`.
3. **`refTimer: true` keeps loop alive** — fake timers: call `killWithEscalation(proc, { escalationMs: 50, refTimer: true })` with no other handles; assert process does not exit until after the SIGKILL fires. Counter-case (`refTimer: false`) asserts the timer was unref'd (loop drains).
4. **Back-compat default** — all existing callers (no opts) still work; SIGKILL escalation unref'd for steady-state dispose.
5. **Windows path unchanged** — `platform()` stubbed to `win32`; assert `execSync` was called with `taskkill /T /F /PID`. (Existing branch, just a guard that 3.2 didn't regress it.)
6. **Dead proc is a no-op** — `proc.killed === true` short-circuits; no throw.

### `AcpClient.connect` + `dispose`
7. **Spawn is detached on POSIX** — assert `spawn` was called with `detached: true` on non-Windows, `detached` absent on Windows. (Stub `child_process.spawn` + `platform`.)
8. **dispose ref-timers the kill** — assert `dispose()` calls `killWithEscalation(proc, { refTimer: true })`. (Spy on the import.)

### Shutdown hook (`index.ts`)
9. **Hook is synchronous** — static-analysis or behavioral: register a stub `pi.on`; invoke the handler; assert it returns `undefined` (not a Promise) OR that all `adapter.dispose()` calls were made synchronously before the first `await` microtask. Use a synchronous adapter stub whose `dispose()` sets a flag; assert flag set immediately after invoking handler.
10. **Hook is kill-first resilient** — first N adapters' `dispose()` throws; assert remaining adapters still get `dispose()` called (per-adapter try/catch).
11. **`beforeExit` fallback** — emit `process.emit("beforeExit")`; assert all adapters disposed. Assert it only fires once (`process.once`).
12. **G2 contract (negative)** — `process.kill(process.pid, "SIGKILL")` on a child pi process with spawned agents: assert (in a forked test harness) that grandchildren survive. This codifies the documented limitation so a future "fix" must delete the test deliberately.

### Integration (real subprocess, POSIX only)
13. **Grandchild reaped on stale-dispose** — spawn adapter with `sh -c 'sleep 600 & wait'`; trigger `dispose()`; assert the inner `sleep 600` PID is gone (poll `/proc/<pid>` or `process.kill(pid, 0)` throws ESRCH).
14. **Grandchild reaped on session_shutdown** — same spawn; invoke the registered `session_shutdown` handler; assert grandchild gone.

## 5. Rollout / risk

- **Risk: MEDIUM.** Touching process spawn/kill — behavior-correct, but timing-sensitive on Windows (unchanged) and CI matrix must cover POSIX. 
- **Blast radius** (run `gitnexus_impact` on `killWithEscalation` before edit — all callers): `AcpClient.dispose` is the only prod caller; tests are the others. Single blast point.
- **Order**: land 3.2 (group kill) → 3.1 (detached spawn) together (3.2 without 3.1 is harmless but 3.1 without 3.2 would change kill semantics). Then 3.3. Each as its own commit; each preceded by its tests (TDD).
- **Back-compat**: `killWithEscalation(proc)` keeps working (opts optional). No call-site sweep needed.
- **Windows**: zero behavior change — guarded by `platform() === "win32"`.
- **Verify before merge**: `npx vitest run test/process-leaks.test.ts test/client-deep.test.ts`; `npx tsc --noEmit`; smoke an `acp_prompt` against a real agent and confirm grandchild MCP servers exit on dispose (`pgrep -P`).
- **Rollback**: revert 3 commits — no schema/config/data migration involved.

## 6. Out of scope (YAGNI)

- ❌ `prctl(PR_SET_PDEATHSIG)` / native binding (Linux-only, native-build cost).
- ❌ Watchdog daemon, pidfd poller, companion reaper process.
- ❌ systemd unit / `KillMode=control-group` / Nomad task wrapper.
- ❌ Replacing `child_process.spawn` with a process-tree library (`tree-kill`, `ps-tree`) — `process.kill(-pgid)` is stdlib-only and DRY with the existing Windows tree kill.
- ❌ Hardening G2 (SIGKILL/OOM of parent) beyond documentation — fundamentally requires kernel or external supervisor.
- ❌ Changing the Windows path (already correct).
- ❌ Adding `process.on("exit")` synchronous-kill logic beyond the existing `beforeExit` — `exit` handler must be sync and cannot dispatch `process.kill` reliably for new groups; `beforeExit` is sufficient.
- ❌ Renaming `killWithEscalation` — preserve API.

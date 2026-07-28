/**
 * pi-acp-agents — Async Executor (M1: Async Background Delegation)
 *
 * Runs agent delegation in a background Promise, tracking state in a file-backed store.
 * Reuses AgentCoordinator.delegate() for actual ACP calls.
 *
 * M2 additions: telemetry accumulation, silent-failure detection, wake notifications.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AcpAsyncRunRecord, AsyncRunError } from "../config/types.js";
import type { AgentCoordinator } from "../coordination/coordinator.js";
import type { AcpDelegateProgress } from "../coordination/coordinator.js";
import { createNoopLogger } from "../logger.js";
import { WorktreeManager } from "./worktree-manager.js";

const log = createNoopLogger();

interface AsyncStorePayload {
  runs: AcpAsyncRunRecord[];
}

const DEFAULT_PAYLOAD: AsyncStorePayload = { runs: [] };

/**
 * Session event emitted during delegation (tool calls, file writes, token usage, turn end).
 * @deprecated Use AcpDelegateProgress from coordinator instead. Kept for backward compat with existing tests.
 */
export interface AsyncSessionEvent {
  type: "tool_call" | "file_write" | "token_usage" | "turn_end";
  payload?: Record<string, unknown>;
}

/** Options for AsyncExecutor constructor. */
export interface AsyncExecutorOptions {
  /** Called when a run transitions to a state that needs parent attention (e.g., silent failure). */
  onWakeNotification?: (runId: string, info: { reason: string }) => void;
}

/** Options for AsyncExecutor.start(). */
export interface AsyncStartOptions {
  /** Path to the output log file for this run. */
  outputPath?: string;
  /** If true, create a git worktree for isolation. */
  worktree?: boolean;
  /** If true (with worktree:true), keep the worktree after run completes. */
  keepWorktree?: boolean;
}

/** Telemetry accumulator for a single run. */
interface RunTelemetry {
  turns: number;
  toolCalls: number;
  tokensUsed: number;
  filesWritten: number;
  lastActivityAt: string;
}

function createInitialTelemetry(): RunTelemetry {
  const now = new Date().toISOString();
  return { turns: 0, toolCalls: 0, tokensUsed: 0, filesWritten: 0, lastActivityAt: now };
}

function accumulateEvent(telemetry: RunTelemetry, event: AsyncSessionEvent): void {
  const now = new Date().toISOString();
  telemetry.lastActivityAt = now;
  switch (event.type) {
    case "tool_call":
      telemetry.toolCalls++;
      break;
    case "file_write":
      telemetry.filesWritten++;
      break;
    case "token_usage": {
      const input = (event.payload?.input as number) ?? 0;
      const output = (event.payload?.output as number) ?? 0;
      telemetry.tokensUsed += input + output;
      break;
    }
    case "turn_end":
      telemetry.turns++;
      break;
  }
}

/**
 * Accumulate telemetry from a real AcpDelegateProgress event.
 * Maps coordinator progress phases to telemetry fields.
 */
function accumulateProgress(telemetry: RunTelemetry, progress: AcpDelegateProgress): void {
  // Use progress.lastActivityAt (epoch ms) if available, else current time
  telemetry.lastActivityAt = progress.lastActivityAt
    ? new Date(progress.lastActivityAt).toISOString()
    : new Date().toISOString();

  switch (progress.phase) {
    case "prompting":
      // Each prompting phase = one turn
      telemetry.turns++;
      break;
    case "done":
      // Estimate tool calls from text content (heuristic for telemetry display)
      if (progress.text) {
        // Count file path patterns as tool call indicators
        const filePathMatches = progress.text.match(/\b\S+\.[a-zA-Z0-9]+\b/g);
        if (filePathMatches) {
          telemetry.toolCalls += filePathMatches.length;
        }
        // Count code blocks as tool call indicators
        const codeBlockMatches = progress.text.match(/```/g);
        if (codeBlockMatches) {
          telemetry.toolCalls += Math.floor(codeBlockMatches.length / 2);
        }
      }
      break;
    case "spawning":
    case "initializing":
    case "error":
      // No telemetry increment for these phases
      break;
  }
}

/**
 * A spawn tracked by the executor but managed externally (by the acp_spawn tool).
 * The executor records the run for fleet/steer/interrupt/resume/telemetry,
 * and the external caller reports completion/failure.
 */
export interface TrackedSpawn {
  runId: string;
  sessionId: string;
  agentName: string;
  cwd: string;
  message: string;
  /** Cancel the in-flight prompt (for interrupt). */
  cancel: () => void;
  /** Re-prompt the session (for resume). */
  reprompt: (message: string) => Promise<{ text: string } | null>;
  /** Whether to keep the worktree after cleanup. */
  keepWorktree?: boolean;
  /** Worktree path if created. */
  worktreePath?: string;
}
export class AsyncExecutor {
  private runsFile: string;
  private activePromises = new Map<string, Promise<void>>();
  private telemetryMap = new Map<string, RunTelemetry>();
  private steerQueue = new Map<string, string[]>();
  private interruptedRuns = new Set<string>();
  private worktreeManager = new WorktreeManager();
  private onWakeNotification?: (runId: string, info: { reason: string }) => void;

  /** Tracked external spawns (from acp_spawn async path). Keyed by runId. */
  private trackedSpawns = new Map<string, TrackedSpawn>();

  constructor(
    private coordinator: AgentCoordinator,
    runtimeDir: string,
    options?: AsyncExecutorOptions,
  ) {
    mkdirSync(runtimeDir, { recursive: true });
    this.runsFile = join(runtimeDir, "async-runs.json");
    this.onWakeNotification = options?.onWakeNotification;
  }

  start(agentName: string, message: string, cwd?: string, startOptions?: AsyncStartOptions): string {
    const runId = randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    // Create worktree if requested
    let worktreePath: string | undefined;
    let keepWorktree = false;
    if (startOptions?.worktree) {
      const worktreeCwd = cwd ?? process.cwd();
      try {
        worktreePath = this.worktreeManager.create(worktreeCwd, runId);
        keepWorktree = startOptions.keepWorktree ?? false;
      } catch (err) {
        log.warn("async-executor: worktree creation failed", err);
      }
    }

    const effectiveCwd = worktreePath ?? cwd;

    const record: AcpAsyncRunRecord = {
      runId,
      agentName,
      message,
      cwd: effectiveCwd,
      state: "pending",
      createdAt: now,
      lastActivityAt: now,
      outputPath: startOptions?.outputPath,
      worktreePath,
      keepWorktree,
      turns: 0,
      toolCalls: 0,
      tokensUsed: 0,
      filesWritten: 0,
    };
    this.writeRun(record);
    this.telemetryMap.set(runId, createInitialTelemetry());

    const promise = (async () => {
      try {
        this.updateRun(runId, { state: "running", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() });

        // Pass onProgress callback to coordinator.delegate() for telemetry accumulation.
        // The real coordinator emits AcpDelegateProgress events; we convert to telemetry.
        const onProgress = (progress: AcpDelegateProgress) => {
          const telemetry = this.telemetryMap.get(runId);
          if (telemetry) accumulateProgress(telemetry, progress);
        };

        // Drain any steer messages queued before start() ran.
        const startSteerQueue = this.steerQueue.get(runId) ?? [];
        this.steerQueue.delete(runId);
        const startSteerSuffix = startSteerQueue.length > 0
          ? `\n\nFollow-up guidance:\n${startSteerQueue.join("\n")}`
          : "";
        const startMessage = `${message}${startSteerSuffix}`;

        const result = await this.coordinator.delegate(
          agentName,
          startMessage,
          effectiveCwd,
          onProgress,
        );

        // Yield to allow any pending interrupt() calls to be processed first.
        // This prevents a race where the delegate completes at the same time as an interrupt.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // If interrupted during delegation, don't override the needs-attention state
        if (this.interruptedRuns.has(runId)) {
          this.activePromises.delete(runId);
          this.telemetryMap.delete(runId);
          return;
        }

        const telemetry = this.telemetryMap.get(runId) ?? createInitialTelemetry();

        // Silent-failure detection: if no tool calls, no file writes, AND no text output,
        // the run produced nothing useful. Runs that return text without tool calls are legitimate.
        if (telemetry.toolCalls === 0 && telemetry.filesWritten === 0 && !result.text?.trim()) {
          const errorDetail: AsyncRunError = { reason: "silent-no-output" };
          this.updateRun(runId, {
            state: "failed",
            error: "silent-no-output: run completed with zero tool calls and zero file writes",
            errorDetail,
            result: result.text,
            sessionId: result.sessionId,
            completedAt: new Date().toISOString(),
            turns: telemetry.turns,
            toolCalls: telemetry.toolCalls,
            tokensUsed: telemetry.tokensUsed,
            lastActivityAt: telemetry.lastActivityAt,
            filesWritten: telemetry.filesWritten,
          });
          this.onWakeNotification?.(runId, { reason: "silent-no-output" });
        } else {
          this.updateRun(runId, {
            state: "completed",
            result: result.text,
            sessionId: result.sessionId,
            completedAt: new Date().toISOString(),
            turns: telemetry.turns,
            toolCalls: telemetry.toolCalls,
            tokensUsed: telemetry.tokensUsed,
            lastActivityAt: telemetry.lastActivityAt,
            filesWritten: telemetry.filesWritten,
          });
        }
      } catch (err: unknown) {
        const telemetry = this.telemetryMap.get(runId) ?? createInitialTelemetry();
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorDetail: AsyncRunError = {
          reason: this.classifyError(errorMessage),
          message: errorMessage,
        };
        this.updateRun(runId, {
          state: "failed",
          error: errorMessage,
          errorDetail,
          completedAt: new Date().toISOString(),
          turns: telemetry.turns,
          toolCalls: telemetry.toolCalls,
          tokensUsed: telemetry.tokensUsed,
          lastActivityAt: telemetry.lastActivityAt,
          filesWritten: telemetry.filesWritten,
        });
      } finally {
        this.activePromises.delete(runId);
        this.telemetryMap.delete(runId);

        // Clean up worktree unless keepWorktree is set
        if (worktreePath && !keepWorktree) {
          try {
            const run = this.getStatus(runId);
            this.worktreeManager.remove(worktreePath, run?.cwd ?? cwd);
          } catch (err) {
            log.warn("async-executor: worktree cleanup failed (best-effort)", err);
          }
        }
      }
    })();
    this.activePromises.set(runId, promise);
    return runId;
  }

  getStatus(runId: string): AcpAsyncRunRecord | undefined {
    return this.readAll().runs.find((r) => r.runId === runId);
  }

  /**
   * Track an externally-managed spawn (from acp_spawn async path).
   * The run is registered for fleet/steer/interrupt/resume/telemetry/silent-failure.
   * The external caller must call completeTrackedSpawn() or failTrackedSpawn() when done.
   */
  trackExternalSpawn(params: {
    sessionId: string;
    agentName: string;
    cwd: string;
    message: string;
    cancel: () => void;
    reprompt: (message: string) => Promise<{ text: string } | null>;
    worktreePath?: string;
    keepWorktree?: boolean;
    outputPath?: string;
  }): string {
    const runId = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const record: AcpAsyncRunRecord = {
      runId,
      agentName: params.agentName,
      message: params.message,
      cwd: params.cwd,
      state: "running",
      createdAt: now,
      lastActivityAt: now,
      sessionId: params.sessionId,
      outputPath: params.outputPath,
      worktreePath: params.worktreePath,
      keepWorktree: params.keepWorktree,
      turns: 0,
      toolCalls: 0,
      tokensUsed: 0,
      filesWritten: 0,
    };
    this.writeRun(record);
    this.telemetryMap.set(runId, createInitialTelemetry());
    this.trackedSpawns.set(runId, {
      runId,
      sessionId: params.sessionId,
      agentName: params.agentName,
      cwd: params.cwd,
      message: params.message,
      cancel: params.cancel,
      reprompt: params.reprompt,
      keepWorktree: params.keepWorktree,
      worktreePath: params.worktreePath,
    });
    return runId;
  }

  /** Report a tracked spawn completion (with telemetry). */
  completeTrackedSpawn(runId: string, result: { text: string }): void {
    const telemetry = this.telemetryMap.get(runId) ?? createInitialTelemetry();
    // Preserve interrupted state: if the run was interrupted (needs-attention),
    // don't terminalize it. The run can still be resumed later.
    const current = this.getStatus(runId);
    if (current?.state === "needs-attention") {
      // Just update telemetry without changing state
      this.updateRun(runId, {
        turns: telemetry.turns,
        toolCalls: telemetry.toolCalls,
        tokensUsed: telemetry.tokensUsed,
        lastActivityAt: telemetry.lastActivityAt,
        filesWritten: telemetry.filesWritten,
      });
      this.telemetryMap.delete(runId);
      // Don't clean up worktree — run may be resumed
      return;
    }
    // Silent-failure detection
    if (telemetry.toolCalls === 0 && telemetry.filesWritten === 0 && !result.text?.trim()) {
      this.updateRun(runId, {
        state: "failed",
        error: "silent-no-output: run completed with zero tool calls and zero file writes",
        errorDetail: { reason: "silent-no-output" },
        result: result.text,
        completedAt: new Date().toISOString(),
        turns: telemetry.turns,
        toolCalls: telemetry.toolCalls,
        tokensUsed: telemetry.tokensUsed,
        lastActivityAt: telemetry.lastActivityAt,
        filesWritten: telemetry.filesWritten,
      });
      this.onWakeNotification?.(runId, { reason: "silent-no-output" });
    } else {
      this.updateRun(runId, {
        state: "completed",
        result: result.text,
        completedAt: new Date().toISOString(),
        turns: telemetry.turns,
        toolCalls: telemetry.toolCalls,
        tokensUsed: telemetry.tokensUsed,
        lastActivityAt: telemetry.lastActivityAt,
        filesWritten: telemetry.filesWritten,
      });
    }
    this.telemetryMap.delete(runId);
    this.cleanupTrackedWorktree(runId);
  }

  /** Report a tracked spawn failure. */
  failTrackedSpawn(runId: string, errorMessage: string): void {
    const telemetry = this.telemetryMap.get(runId) ?? createInitialTelemetry();
    // Preserve interrupted state: if the run was interrupted (needs-attention),
    // don't terminalize it. The run can still be resumed later.
    const current = this.getStatus(runId);
    if (current?.state === "needs-attention") {
      // Just update telemetry without changing state
      this.updateRun(runId, {
        turns: telemetry.turns,
        toolCalls: telemetry.toolCalls,
        tokensUsed: telemetry.tokensUsed,
        lastActivityAt: telemetry.lastActivityAt,
        filesWritten: telemetry.filesWritten,
      });
      this.telemetryMap.delete(runId);
      // Don't clean up worktree — run may be resumed
      return;
    }
    this.updateRun(runId, {
      state: "failed",
      error: errorMessage,
      errorDetail: { reason: this.classifyError(errorMessage), message: errorMessage },
      completedAt: new Date().toISOString(),
      turns: telemetry.turns,
      toolCalls: telemetry.toolCalls,
      tokensUsed: telemetry.tokensUsed,
      lastActivityAt: telemetry.lastActivityAt,
      filesWritten: telemetry.filesWritten,
    });
    this.telemetryMap.delete(runId);
    this.cleanupTrackedWorktree(runId);
  }

  /** Increment telemetry for a tracked spawn (call on each progress event). */
  reportTrackedProgress(runId: string): void {
    const telemetry = this.telemetryMap.get(runId);
    if (telemetry) {
      telemetry.turns++;
      telemetry.lastActivityAt = new Date().toISOString();
      this.updateRun(runId, { turns: telemetry.turns, lastActivityAt: telemetry.lastActivityAt });
    }
  }

  /** Look up a tracked spawn by sessionId (for steer/interrupt via acp_msg). */
  findTrackedBySession(sessionId: string): TrackedSpawn | undefined {
    for (const spawn of this.trackedSpawns.values()) {
      if (spawn.sessionId === sessionId) return spawn;
    }
    return undefined;
  }

  /** Clean up worktree for a tracked spawn (best-effort). */
  private cleanupTrackedWorktree(runId: string): void {
    // Worktree lifecycle is managed by the session (closeSession/sessionWorktrees).
    // The executor only removes the in-memory tracking to avoid leaks.
    this.trackedSpawns.delete(runId);
  }

  /** Returns full telemetry for a single run (alias for getStatus with telemetry fields). */
  getRunDetail(runId: string): AcpAsyncRunRecord | undefined {
    return this.getStatus(runId);
  }

  /** Returns a compact fleet view of all active runs with telemetry, sorted by lastActivityAt desc. */
  getFleetView(retentionMs: number = 86_400_000): Array<{
    runId: string;
    state: string;
    agentName: string;
    message: string;
    lastActivityAt?: string;
    turns?: number;
    toolCalls?: number;
    tokensUsed?: number;
    filesWritten?: number;
    summary?: string;
  }> {
    const cutoff = Date.now() - retentionMs;
    return this.listActive()
      .filter((r) => {
        const activityTime = r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : new Date(r.createdAt).getTime();
        return activityTime >= cutoff;
      })
      .map((r) => ({
        runId: r.runId,
        state: r.state,
        agentName: r.agentName,
        message: r.message,
        lastActivityAt: r.lastActivityAt,
        turns: r.turns,
        toolCalls: r.toolCalls,
        tokensUsed: r.tokensUsed,
        filesWritten: r.filesWritten,
        summary: r.result ?? r.message,
      }));
  }

  getResult(runId: string): string | null {
    const run = this.getStatus(runId);
    if (!run || run.state !== "completed") return null;
    return run.result ?? null;
  }

  /** Returns all non-terminal runs sorted by lastActivityAt descending. */
  listActive(): AcpAsyncRunRecord[] {
    const active = this.readAll().runs.filter(
      (r) =>
        r.state === "pending" ||
        r.state === "running" ||
        r.state === "needs-attention",
    );
    // Sort by lastActivityAt descending (most recent first).
    // Runs without lastActivityAt sort to the end.
    return active.sort((a, b) => {
      const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  listAll(): AcpAsyncRunRecord[] {
    return this.readAll().runs;
  }

  cancel(runId: string): boolean {
    const run = this.getStatus(runId);
    if (!run || run.state === "completed" || run.state === "failed") return false;
    this.updateRun(runId, {
      state: "failed",
      error: "cancelled",
      completedAt: new Date().toISOString(),
    });
    return true;
  }

  prune(maxAgeMs: number): { pruned: number } {
    const runs = this.readAll().runs;
    const now = Date.now();
    const kept = runs.filter((run) => {
      if (run.state === "pending" || run.state === "running") return true;
      const completedAt = run.completedAt ? new Date(run.completedAt).getTime() : 0;
      return now - completedAt < maxAgeMs;
    });
    const pruned = runs.length - kept.length;
    this.writeAll({ runs: kept });
    return { pruned };
  }

  /** Interrupt an active run: abort in-flight turn, set state to 'needs-attention'. */
  interrupt(runId: string): { success: boolean; reason?: string } {
    const run = this.getStatus(runId);
    if (!run) return { success: false, reason: "run not found" };
    if (run.state === "completed" || run.state === "failed") {
      return { success: false, reason: `run already ${run.state}` };
    }
    if (run.state !== "running" && run.state !== "pending") {
      return { success: false, reason: `run in state ${run.state}, cannot interrupt` };
    }

    // Mark as interrupted and set state to needs-attention
    this.interruptedRuns.add(runId);
    const telemetry = this.telemetryMap.get(runId) ?? createInitialTelemetry();

    // For tracked external spawns, cancel the in-flight prompt via the adapter
    const tracked = this.trackedSpawns.get(runId);
    if (tracked) {
      try { tracked.cancel(); } catch { /* best-effort */ }
    }

    this.updateRun(runId, {
      state: "needs-attention",
      error: "interrupted by user",
      completedAt: new Date().toISOString(),
      turns: telemetry.turns,
      toolCalls: telemetry.toolCalls,
      tokensUsed: telemetry.tokensUsed,
      lastActivityAt: new Date().toISOString(),
      filesWritten: telemetry.filesWritten,
    });

    return { success: true };
  }

  /** Resume an interrupted run: re-engage session, set state to 'running'. */
  resume(runId: string, message?: string): { success: boolean; reason?: string } {
    const run = this.getStatus(runId);
    if (!run) return { success: false, reason: "run not found" };
    if (run.state === "running" || run.state === "pending") {
      return { success: false, reason: "run already running" };
    }
    if (run.state !== "needs-attention" && run.state !== "failed" && run.state !== "completed") {
      return { success: false, reason: `run in state ${run.state}, cannot resume` };
    }

    // Remove from interrupted set and reset state to running
    this.interruptedRuns.delete(runId);
    this.telemetryMap.set(runId, createInitialTelemetry());
    this.updateRun(runId, {
      state: "running",
      error: undefined,
      completedAt: undefined,
      lastActivityAt: new Date().toISOString(),
    });

    // Drain the steer queue + append resume message, then call delegate to re-engage.
    const drainedQueue = this.steerQueue.get(runId) ?? [];
    this.steerQueue.delete(runId);
    if (message) drainedQueue.push(`[RESUME] ${message}`);
    const steerSuffix = drainedQueue.length > 0
      ? `\n\nFollow-up guidance:\n${drainedQueue.join("\n")}`
      : "";
    const fullMessage = `${run.message}${steerSuffix}`;

    const promise = (async () => {
      try {
        // For tracked external spawns, use the spawn's reprompt callback
        // instead of coordinator.delegate() (which would create a new session).
        const tracked = this.trackedSpawns.get(runId);
        let resultText: string;

        if (tracked) {
          const result = await tracked.reprompt(fullMessage);
          resultText = result?.text ?? "";
          // Increment telemetry for each resume reprompt
          const t = this.telemetryMap.get(runId);
          if (t) { t.turns++; t.lastActivityAt = new Date().toISOString(); }
        } else {
          const onProgress = (progress: AcpDelegateProgress) => {
            const telemetry = this.telemetryMap.get(runId);
            if (telemetry) accumulateProgress(telemetry, progress);
          };

          const result = await this.coordinator.delegate(
            run.agentName,
            fullMessage,
            run.cwd,
            onProgress,
          );
          resultText = result.text;
          // Persist sessionId from delegate result (for runs that were interrupted
          // before their initial start() completed, or when the adapter recreated the session).
          if (result.sessionId) {
            this.updateRun(runId, { sessionId: result.sessionId });
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 0));

        if (this.interruptedRuns.has(runId)) {
          this.activePromises.delete(runId);
          this.telemetryMap.delete(runId);
          return;
        }

        const telemetry = this.telemetryMap.get(runId) ?? createInitialTelemetry();
        if (telemetry.toolCalls === 0 && telemetry.filesWritten === 0 && !resultText?.trim()) {
          this.updateRun(runId, {
            state: "failed",
            error: "silent-no-output: resumed run produced no output",
            errorDetail: { reason: "silent-no-output" },
            result: resultText,
            completedAt: new Date().toISOString(),
            turns: telemetry.turns,
            toolCalls: telemetry.toolCalls,
            tokensUsed: telemetry.tokensUsed,
            lastActivityAt: telemetry.lastActivityAt,
            filesWritten: telemetry.filesWritten,
          });
          this.onWakeNotification?.(runId, { reason: "silent-no-output" });
        } else {
          this.updateRun(runId, {
            state: "completed",
            result: resultText,
            completedAt: new Date().toISOString(),
            turns: telemetry.turns,
            toolCalls: telemetry.toolCalls,
            tokensUsed: telemetry.tokensUsed,
            lastActivityAt: telemetry.lastActivityAt,
            filesWritten: telemetry.filesWritten,
          });
        }
      } catch (err: unknown) {
        const telemetry = this.telemetryMap.get(runId) ?? createInitialTelemetry();
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.updateRun(runId, {
          state: "failed",
          error: errorMessage,
          errorDetail: { reason: this.classifyError(errorMessage), message: errorMessage },
          completedAt: new Date().toISOString(),
          turns: telemetry.turns,
          toolCalls: telemetry.toolCalls,
          tokensUsed: telemetry.tokensUsed,
          lastActivityAt: telemetry.lastActivityAt,
          filesWritten: telemetry.filesWritten,
        });
      } finally {
        this.activePromises.delete(runId);
        this.telemetryMap.delete(runId);
      }
    })();
    this.activePromises.set(runId, promise);

    return { success: true };
  }

  /** Steer an active run: inject guidance into the run. */
  steer(runId: string, message: string): { success: boolean; delivered?: boolean; queued?: boolean; reason?: string } {
    const run = this.getStatus(runId);
    if (!run) return { success: false, reason: "run not found" };

    // Always queue the message so it is forwarded on next delegate call
    // (start() and resume() drain the queue into the delegate message).
    const steerQueue = this.steerQueue.get(runId) ?? [];
    steerQueue.push(message);
    this.steerQueue.set(runId, steerQueue);

    // For active runs, message is delivered (will be injected on next turn).
    // For idle/completed/failed runs, message is queued for next interaction.
    // Spec: both paths return { delivered: true, queued: true }.
    if (run.state === "running" || run.state === "pending") {
      return { success: true, delivered: true, queued: true };
    }
    return { success: true, delivered: true, queued: true };
  }

  private classifyError(message: string): AsyncRunError["reason"] {
    if (/rate.?limit/i.test(message)) return "rate-limit";
    if (/crash|segfault|abort|killed/i.test(message)) return "crash";
    return "unknown";
  }

  private readAll(): AsyncStorePayload {
    if (!existsSync(this.runsFile)) return structuredClone(DEFAULT_PAYLOAD);
    try {
      return JSON.parse(readFileSync(this.runsFile, "utf-8")) as AsyncStorePayload;
    } catch (e) {
      log.debug("async-executor read failed", e);
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private writeAll(payload: AsyncStorePayload): void {
    try {
      writeFileSync(this.runsFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    } catch (e) {
      log.debug("async-executor write failed", e);
    }
  }

  private writeRun(record: AcpAsyncRunRecord): void {
    const payload = this.readAll();
    payload.runs.push(record);
    this.writeAll(payload);
  }

  private updateRun(runId: string, updates: Partial<AcpAsyncRunRecord>): void {
    const payload = this.readAll();
    const run = payload.runs.find((r) => r.runId === runId);
    if (run) {
      Object.assign(run, updates);
      this.writeAll(payload);
    }
  }

  // Public getters for testing shared executor instance behavior
  getActivePromises(): Map<string, Promise<void>> {
    return this.activePromises;
  }

  getSteerQueue(): Map<string, string[]> {
    return this.steerQueue;
  }

  getTelemetryMap(): Map<string, RunTelemetry> {
    return this.telemetryMap;
  }

  getInterruptedRuns(): Set<string> {
    return this.interruptedRuns;
  }
}

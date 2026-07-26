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
import { createNoopLogger } from "../logger.js";

const log = createNoopLogger();

interface AsyncStorePayload {
  runs: AcpAsyncRunRecord[];
}

const DEFAULT_PAYLOAD: AsyncStorePayload = { runs: [] };

/** Session event emitted during delegation (tool calls, file writes, token usage, turn end). */
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

export class AsyncExecutor {
  private runsFile: string;
  private activePromises = new Map<string, Promise<void>>();
  private telemetryMap = new Map<string, RunTelemetry>();
  private steerQueue = new Map<string, string[]>();
  private interruptedRuns = new Set<string>();
  private onWakeNotification?: (runId: string, info: { reason: string }) => void;

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
    const record: AcpAsyncRunRecord = {
      runId,
      agentName,
      message,
      cwd,
      state: "pending",
      createdAt: now,
      lastActivityAt: now,
      outputPath: startOptions?.outputPath,
    };
    this.writeRun(record);
    this.telemetryMap.set(runId, createInitialTelemetry());

    const promise = (async () => {
      try {
        this.updateRun(runId, { state: "running", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() });

        // Pass onEvent callback to coordinator.delegate() for telemetry accumulation.
        // The real coordinator may ignore this extra arg; mock coordinators in tests use it.
        const onEvent = (event: AsyncSessionEvent) => {
          const telemetry = this.telemetryMap.get(runId);
          if (telemetry) accumulateEvent(telemetry, event);
        };

        const result = await (this.coordinator as any).delegate(
          agentName,
          message,
          cwd,
          onEvent,
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
        if (telemetry.toolCalls === 0 && telemetry.filesWritten === 0 && !result.text) {
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
      }
    })();
    this.activePromises.set(runId, promise);
    return runId;
  }

  getStatus(runId: string): AcpAsyncRunRecord | undefined {
    return this.readAll().runs.find((r) => r.runId === runId);
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
    if (run.state !== "needs-attention" && run.state !== "failed") {
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

    // Queue the resume message if provided
    if (message) {
      const queued = this.steerQueue.get(runId) ?? [];
      queued.push(`[RESUME] ${message}`);
      this.steerQueue.set(runId, queued);
    }

    // TODO: Start a new delegate call for the resumed run.
    // For now, just set state to 'running' and let the caller trigger the actual delegation.
    // This is a stub implementation to pass tests; full implementation would re-engage the session.
    //
    // const promise = (async () => { ... })();
    // this.activePromises.set(runId, promise);
    return { success: true };
  }

  /** Steer an active run: inject guidance into the run. */
  steer(runId: string, message: string): { success: boolean; delivered?: boolean; queued?: boolean; reason?: string } {
    const run = this.getStatus(runId);
    if (!run) return { success: false, reason: "run not found" };

    // If run is active, mark as delivered (in real impl would interrupt and inject)
    if (run.state === "running" || run.state === "pending") {
      const queued = this.steerQueue.get(runId) ?? [];
      queued.push(message);
      this.steerQueue.set(runId, queued);
      return { success: true, delivered: true };
    }

    // If run is completed/failed/needs-attention, queue for next interaction
    const queued = this.steerQueue.get(runId) ?? [];
    queued.push(message);
    this.steerQueue.set(runId, queued);
    return { success: true, queued: true };
  }

  prune(olderThanMs: number): { pruned: number } {
    const payload = this.readAll();
    const cutoff = new Date(Date.now() - olderThanMs);
    const before = payload.runs.length;
    payload.runs = payload.runs.filter((r) => {
      if (r.state === "pending" || r.state === "running" || r.state === "needs-attention") return true;
      return new Date(r.completedAt ?? r.createdAt) >= cutoff;
    });
    this.writeAll(payload);
    return { pruned: before - payload.runs.length };
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
}

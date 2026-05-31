/**
 * pi-acp-agents — Async Executor (M1: Async Background Delegation)
 *
 * Runs agent delegation in a background Promise, tracking state in a file-backed store.
 * Reuses AgentCoordinator.delegate() for actual ACP calls.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AcpAsyncRunRecord } from "../config/types.js";
import type { AgentCoordinator } from "../coordination/coordinator.js";

interface AsyncStorePayload {
  runs: AcpAsyncRunRecord[];
}

const DEFAULT_PAYLOAD: AsyncStorePayload = { runs: [] };

export class AsyncExecutor {
  private runsFile: string;
  private activePromises = new Map<string, Promise<void>>();

  constructor(
    private coordinator: AgentCoordinator,
    runtimeDir: string,
  ) {
    mkdirSync(runtimeDir, { recursive: true });
    this.runsFile = join(runtimeDir, "async-runs.json");
  }

  start(agentName: string, message: string, cwd?: string): string {
    const runId = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const record: AcpAsyncRunRecord = {
      runId,
      agentName,
      message,
      cwd,
      state: "pending",
      createdAt: now,
    };
    this.writeRun(record);

    const promise = (async () => {
      try {
        this.updateRun(runId, { state: "running", startedAt: new Date().toISOString() });
        const result = await this.coordinator.delegate(agentName, message, cwd);
        this.updateRun(runId, {
          state: "completed",
          result: result.text,
          sessionId: result.sessionId,
          completedAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        this.updateRun(runId, {
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
          completedAt: new Date().toISOString(),
        });
      } finally {
        this.activePromises.delete(runId);
      }
    })();
    this.activePromises.set(runId, promise);
    return runId;
  }

  getStatus(runId: string): AcpAsyncRunRecord | undefined {
    return this.readAll().runs.find((r) => r.runId === runId);
  }

  getResult(runId: string): string | null {
    const run = this.getStatus(runId);
    if (!run || run.state !== "completed") return null;
    return run.result ?? null;
  }

  listActive(): AcpAsyncRunRecord[] {
    return this.readAll().runs.filter(
      (r) => r.state === "pending" || r.state === "running",
    );
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

  prune(olderThanMs: number): { pruned: number } {
    const payload = this.readAll();
    const cutoff = new Date(Date.now() - olderThanMs);
    const before = payload.runs.length;
    payload.runs = payload.runs.filter((r) => {
      if (r.state === "pending" || r.state === "running") return true;
      return new Date(r.completedAt ?? r.createdAt) >= cutoff;
    });
    this.writeAll(payload);
    return { pruned: before - payload.runs.length };
  }

  private readAll(): AsyncStorePayload {
    if (!existsSync(this.runsFile)) return structuredClone(DEFAULT_PAYLOAD);
    try {
      return JSON.parse(readFileSync(this.runsFile, "utf-8")) as AsyncStorePayload;
    } catch {
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private writeAll(payload: AsyncStorePayload): void {
    try {
      writeFileSync(this.runsFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    } catch {
      // EACCES or other FS error — silently degrade.
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

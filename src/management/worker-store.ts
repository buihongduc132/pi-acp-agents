/**
 * pi-acp-agents — Worker Store (M6: Worker Lifecycle)
 *
 * File-backed store for persistent worker identities.
 * Same pattern as AcpTaskStore and MailboxManager.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";
import type { AcpWorkerRecord, AcpWorkerStatus } from "../config/types.js";

interface WorkerPayload {
  workers: AcpWorkerRecord[];
}

const DEFAULT_PAYLOAD: WorkerPayload = { workers: [] };

export class WorkerStore {
  constructor(private rootDir?: string) {}

  register(input: { name: string; sessionId: string; agentName: string }): AcpWorkerRecord {
    const payload = this.read();
    const existing = payload.workers.find((w) => w.name === input.name);
    if (existing) {
      existing.sessionId = input.sessionId;
      existing.status = "online";
      existing.lastActivityAt = new Date().toISOString();
      this.write(payload);
      return existing;
    }
    const now = new Date().toISOString();
    const worker: AcpWorkerRecord = {
      name: input.name,
      sessionId: input.sessionId,
      agentName: input.agentName,
      status: "online",
      spawnedAt: now,
      lastActivityAt: now,
      metadata: {},
    };
    payload.workers.push(worker);
    this.write(payload);
    return worker;
  }

  get(name: string): AcpWorkerRecord | undefined {
    return this.read().workers.find((w) => w.name === name);
  }

  list(options?: { status?: AcpWorkerStatus }): AcpWorkerRecord[] {
    const workers = this.read().workers;
    if (options?.status) return workers.filter((w) => w.status === options.status);
    return workers;
  }

  updateStatus(name: string, status: AcpWorkerStatus): AcpWorkerRecord {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    if (!worker) throw new Error(`Worker "${name}" not found`);
    worker.status = status;
    worker.lastActivityAt = new Date().toISOString();
    this.write(payload);
    return worker;
  }

  assignTask(name: string, taskId: string): void {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    if (!worker) throw new Error(`Worker "${name}" not found`);
    worker.currentTaskId = taskId;
    this.write(payload);
  }

  clearTask(name: string): void {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    if (worker) {
      worker.currentTaskId = undefined;
      this.write(payload);
    }
  }

  unregister(name: string): void {
    const payload = this.read();
    payload.workers = payload.workers.filter((w) => w.name !== name);
    this.write(payload);
  }

  pruneStale(cutoffMs = 3_600_000): { pruned: string[] } {
    const payload = this.read();
    const cutoff = new Date(Date.now() - cutoffMs);
    const pruned: string[] = [];
    for (const w of payload.workers) {
      if (w.status !== "offline" && new Date(w.lastActivityAt) < cutoff) {
        w.status = "offline";
        pruned.push(w.name);
      }
    }
    this.write(payload);
    return { pruned };
  }

  countOnline(): number {
    return this.read().workers.filter((w) => w.status !== "offline").length;
  }

  private read(): WorkerPayload {
    const paths = ensureRuntimeDir(this.rootDir);
    if (!existsSync(paths.workersFile)) return structuredClone(DEFAULT_PAYLOAD);
    try {
      return JSON.parse(readFileSync(paths.workersFile, "utf-8")) as WorkerPayload;
    } catch {
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private write(payload: WorkerPayload): void {
    const paths = ensureRuntimeDir(this.rootDir);
    writeFileSync(paths.workersFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
}

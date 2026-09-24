/**
 * pi-acp-agents — Worker Store (M6: Worker Lifecycle)
 *
 * File-backed store for persistent worker identities.
 * Same pattern as AcpTaskStore and MailboxManager.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";
import { createNoopLogger } from "../logger.js";
import { writeChildUsage } from "./child-usage-sink.js";
import type { AcpWorkerRecord, AcpWorkerStatus } from "../config/types.js";

const log = createNoopLogger();

interface WorkerPayload {
  workers: AcpWorkerRecord[];
}

const DEFAULT_PAYLOAD: WorkerPayload = { workers: [] };

export class WorkerStore {
  constructor(
    private rootDir?: string,
    private sessionId?: string,
  ) {
    if (!sessionId || sessionId.trim() === "") {
      throw new Error("WorkerStore requires a non-empty sessionId");
    }
  }

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
    // Materialize the sink file on first register so external readers see the
    // child immediately, even before the first heartbeat.
    this.writeUsage(worker);
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
    // Terminal transition → record endedAt + durationMs in the shared sink.
    if (status === "offline") this.writeTerminalUsage(worker);
    return worker;
  }

  assignTask(name: string, taskId: string): void {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    if (!worker) throw new Error(`Worker "${name}" not found`);
    worker.currentTaskId = taskId;
    this.write(payload);
  }

  touch(name: string, deltas?: { tokenDelta?: number; toolCallDelta?: number }): AcpWorkerRecord {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    if (!worker) throw new Error(`Worker "${name}" not found`);
    const now = new Date().toISOString();
    worker.lastHeartbeatAt = now;
    worker.lastActivityAt = now;
    if (deltas?.tokenDelta) {
      worker.tokenCountTotal = (worker.tokenCountTotal ?? 0) + deltas.tokenDelta;
    }
    if (deltas?.toolCallDelta) {
      worker.toolCallCount = (worker.toolCallCount ?? 0) + deltas.toolCallDelta;
    }
    this.write(payload);
    // Mirror usage to shared sink (non-blocking; honors PI_ACP_CHILD_USAGE_DIR).
    this.writeUsage(worker);
    return worker;
  }

  unassignTask(name: string): AcpWorkerRecord {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    if (!worker) throw new Error(`Worker "${name}" not found`);
    worker.currentTaskId = undefined;
    this.write(payload);
    return worker;
  }

  unregister(name: string): void {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    // Terminal usage write BEFORE removal (we need the record + sessionId).
    if (worker) this.writeTerminalUsage(worker);
    payload.workers = payload.workers.filter((w) => w.name !== name);
    this.write(payload);
  }

  /** Update worker metadata fields */
  updateMetadata(name: string, metadata: Partial<Record<string, unknown>>): AcpWorkerRecord | undefined {
    const payload = this.read();
    const worker = payload.workers.find((w) => w.name === name);
    if (!worker) return undefined;
    for (const [k, v] of Object.entries(metadata)) {
      if (v === undefined) {
        delete worker.metadata[k];
      } else {
        worker.metadata[k] = v;
      }
    }
    this.write(payload);
    return worker;
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
    try {
      const paths = ensureRuntimeDir(this.rootDir, this.sessionId);
      if (!existsSync(paths.workersFile)) return structuredClone(DEFAULT_PAYLOAD);
      return JSON.parse(readFileSync(paths.workersFile, "utf-8")) as WorkerPayload;
    } catch (e) {
      // File read failed — return default payload
      log.debug("worker-store read failed", e);
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private write(payload: WorkerPayload): void {
    try {
      const paths = ensureRuntimeDir(this.rootDir, this.sessionId);
      writeFileSync(paths.workersFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    } catch (e) {
      // File read failed — return default payload
      // EACCES or other FS error — silently degrade. Workers are non-critical runtime state.
      log.debug("worker-store write failed", e);
    }
  }

  /** Mirror worker usage to the shared child-usage sink (non-blocking). */
  private writeUsage(worker: AcpWorkerRecord): void {
    writeChildUsage({
      childSessionId: worker.sessionId,
      parentSessionId: this.sessionId ?? null,
      source: "acp",
      tokensTotal: worker.tokenCountTotal ?? 0,
      toolCalls: worker.toolCallCount ?? 0,
      // ACP has no per-turn events; turns stays 0 (documented in sink module).
      turns: 0,
      startedAt: worker.spawnedAt,
    });
  }

  /** Terminal write — adds endedAt + durationMs to the shared sink. */
  private writeTerminalUsage(worker: AcpWorkerRecord): void {
    writeChildUsage({
      childSessionId: worker.sessionId,
      parentSessionId: this.sessionId ?? null,
      source: "acp",
      tokensTotal: worker.tokenCountTotal ?? 0,
      toolCalls: worker.toolCallCount ?? 0,
      turns: 0,
      startedAt: worker.spawnedAt,
      endedAt: new Date().toISOString(),
    });
  }
}

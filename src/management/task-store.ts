import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";
import { createNoopLogger } from "../logger.js";
import type { AcpTaskPriority } from "../config/types.js";

const log = createNoopLogger();

export type AcpTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface AcpTaskRecord {
  id: string;
  subject: string;
  description?: string;
  status: AcpTaskStatus;
  assignee?: string;
  result?: string;
  blockedBy: string[];
  blocks: string[];
  priority: AcpTaskPriority;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface AcpTaskStorePayload {
  nextId: number;
  tasks: AcpTaskRecord[];
}

const DEFAULT_PAYLOAD: AcpTaskStorePayload = {
  nextId: 1,
  tasks: [],
};

export class AcpTaskStore {
  constructor(
    private rootDir?: string,
    private sessionId?: string,
  ) {
    if (!sessionId || sessionId.trim() === "") {
      throw new Error("AcpTaskStore requires a non-empty sessionId");
    }
  }

  list(options?: { status?: AcpTaskStatus; includeDeleted?: boolean }): AcpTaskRecord[] {
    const payload = this.read();
    return payload.tasks.filter((task) => {
      if (!options?.includeDeleted && task.status === "deleted") return false;
      if (options?.status && task.status !== options.status) return false;
      return true;
    });
  }

  get(id: string): AcpTaskRecord | undefined {
    return this.read().tasks.find((task) => task.id === id);
  }

  create(input: { subject: string; description?: string; assignee?: string; deps?: string[] }): AcpTaskRecord {
    const payload = this.read();
    const now = new Date().toISOString();
    const task: AcpTaskRecord = {
      id: String(payload.nextId++),
      subject: input.subject,
      description: input.description,
      assignee: input.assignee,
      status: "pending",
      blockedBy: input.deps ?? [],
      blocks: [],
      priority: "normal",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    payload.tasks.push(task);
    this.write(payload);
    return task;
  }

  update(id: string, mutate: (task: AcpTaskRecord) => void): AcpTaskRecord {
    const payload = this.read();
    const task = payload.tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Task \"${id}\" not found`);
    mutate(task);
    task.updatedAt = new Date().toISOString();
    this.write(payload);
    return task;
  }

  clear(mode: "completed" | "all" = "completed"): { removed: number; remaining: number } {
    const payload = this.read();
    const before = payload.tasks.length;
    if (mode === "all") {
      payload.tasks = [];
    } else {
      payload.tasks = payload.tasks.filter((task) => task.status !== "completed" && task.status !== "deleted");
    }
    const removed = before - payload.tasks.length;
    this.write(payload);
    return { removed, remaining: payload.tasks.length };
  }

  /** Bulk update tasks matching a filter. Returns updated tasks. */
  updateWhere(filter: string, mutate: (task: AcpTaskRecord) => void): AcpTaskRecord[] {
    const payload = this.read();
    const updated: AcpTaskRecord[] = [];
    for (const task of payload.tasks) {
      let matches = false;
      if (filter === "completed" && task.status === "completed") matches = true;
      else if (filter === "pending" && task.status === "pending") matches = true;
      else if (filter === "in_progress" && task.status === "in_progress") matches = true;
      else if (filter === "" || filter === "all") matches = true;
      if (matches) {
        mutate(task);
        task.updatedAt = new Date().toISOString();
        updated.push(task);
      }
    }
    if (updated.length > 0) this.write(payload);
    return updated;
  }

  /** List tasks with full dependency graph details. */
  listWithDetails(): AcpTaskRecord[] {
    return this.list({ includeDeleted: true });
  }

  /** Create task with priority + metadata support (M3, M5) */
  createWithPriority(input: { subject: string; description?: string; assignee?: string; priority?: AcpTaskPriority; blockedBy?: string[] }): AcpTaskRecord {
    const payload = this.read();
    const now = new Date().toISOString();
    const task: AcpTaskRecord = {
      id: String(payload.nextId++),
      subject: input.subject,
      description: input.description,
      assignee: input.assignee,
      status: "pending",
      blockedBy: input.blockedBy ?? [],
      blocks: [],
      priority: input.priority ?? "normal",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    // Maintain reverse edges
    for (const depId of task.blockedBy) {
      const dep = payload.tasks.find((t) => t.id === depId);
      if (dep && !dep.blocks.includes(task.id)) dep.blocks.push(task.id);
    }
    payload.tasks.push(task);
    this.write(payload);
    return task;
  }

  /** DFS cycle detection — returns path if cycle found, null otherwise (M5) */
  findDependencyPath(fromId: string, toId: string): string[] | null {
    const tasks = this.read().tasks;
    const visited = new Set<string>();
    const path: string[] = [];

    function dfs(currentId: string): boolean {
      if (currentId === toId) {
        path.push(currentId);
        return true;
      }
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      path.push(currentId);
      const task = tasks.find((t) => t.id === currentId);
      if (task) {
        for (const depId of task.blockedBy) {
          if (dfs(depId)) return true;
        }
      }
      path.pop();
      return false;
    }

    return dfs(fromId) ? path : null;
  }

  /** Check if a task is blocked by incomplete dependencies (M5, M3) */
  isTaskBlocked(taskId: string): { blocked: boolean; blockedBy: string[] } {
    const tasks = this.read().tasks;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.blockedBy.length === 0) return { blocked: false, blockedBy: [] };
    const incompleteDeps = task.blockedBy.filter((depId) => {
      const dep = tasks.find((t) => t.id === depId);
      return !dep || dep.status !== "completed";
    });
    return { blocked: incompleteDeps.length > 0, blockedBy: incompleteDeps };
  }

  /** Auto-claim next available task for a worker (M3) */
  claimNextAvailable(workerName: string, options?: { excludeTaskIds?: string[] }): AcpTaskRecord | null {
    const PRIORITY_ORDER: AcpTaskPriority[] = ["urgent", "high", "normal", "low"];
    const payload = this.read();

    const sorted = [...payload.tasks].sort((a, b) => {
      const pi = PRIORITY_ORDER.indexOf(a.priority);
      const bi = PRIORITY_ORDER.indexOf(b.priority);
      if (pi !== bi) return pi - bi;
      return parseInt(a.id) - parseInt(b.id);
    });

    const exclude = new Set(options?.excludeTaskIds ?? []);

    for (const task of sorted) {
      if (task.status !== "pending") continue;
      if (task.assignee) continue;
      if (exclude.has(task.id)) continue;
      // Check blocked
      const incompleteDeps = task.blockedBy.filter((depId) => {
        const dep = payload.tasks.find((t) => t.id === depId);
        return !dep || dep.status !== "completed";
      });
      if (incompleteDeps.length > 0) continue;
      // Check retry exhausted
      if (task.metadata?.retryExhausted === true) continue;
      // Check cooldown
      if (
        task.metadata?.cooldownUntil &&
        new Date(task.metadata.cooldownUntil as string) > new Date()
      )
        continue;
      // Claim
      task.assignee = workerName;
      task.status = "in_progress";
      task.metadata.claimedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();
      this.write(payload);
      return task;
    }
    return null;
  }

  private read(): AcpTaskStorePayload {
    try {
      const paths = ensureRuntimeDir(this.rootDir, this.sessionId);
      if (!existsSync(paths.tasksFile)) {
        return structuredClone(DEFAULT_PAYLOAD);
      }
      const parsed = JSON.parse(readFileSync(paths.tasksFile, "utf-8")) as AcpTaskStorePayload;
      // Migration: add defaults for legacy records
      for (const task of parsed.tasks) {
        if (!task.blocks) task.blocks = [];
        if (!task.priority) task.priority = "normal";
        if (!task.metadata) task.metadata = {};
      }
      return parsed;
    } catch (e) {
      // File read failed — return default payload
      log.debug("task-store read failed", e);
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private write(payload: AcpTaskStorePayload): void {
    try {
      const paths = ensureRuntimeDir(this.rootDir, this.sessionId);
      writeFileSync(paths.tasksFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    } catch (e) {
      // File read failed — return default payload
      // EACCES or other FS error — silently degrade. Tasks are non-critical runtime state.
      log.debug("task-store write failed", e);
    }
  }
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";

export type AcpTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface AcpTaskRecord {
  id: string;
  subject: string;
  description?: string;
  status: AcpTaskStatus;
  assignee?: string;
  result?: string;
  blockedBy: string[];
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
  constructor(private rootDir?: string) {}

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

  create(input: { subject: string; description?: string; assignee?: string }): AcpTaskRecord {
    const payload = this.read();
    const now = new Date().toISOString();
    const task: AcpTaskRecord = {
      id: String(payload.nextId++),
      subject: input.subject,
      description: input.description,
      assignee: input.assignee,
      status: "pending",
      blockedBy: [],
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

  private read(): AcpTaskStorePayload {
    const paths = ensureRuntimeDir(this.rootDir);
    if (!existsSync(paths.tasksFile)) {
      return structuredClone(DEFAULT_PAYLOAD);
    }
    try {
      return JSON.parse(readFileSync(paths.tasksFile, "utf-8")) as AcpTaskStorePayload;
    } catch {
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private write(payload: AcpTaskStorePayload): void {
    const paths = ensureRuntimeDir(this.rootDir);
    writeFileSync(paths.tasksFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
}

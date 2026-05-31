import { appendFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";

export interface AcpEventLogEntry {
  timestamp: string;
  type: string;
  data?: Record<string, unknown>;
}

export class AcpEventLog {
  constructor(private rootDir?: string) {}

  append(type: string, data?: Record<string, unknown>): AcpEventLogEntry {
    const entry: AcpEventLogEntry = {
      timestamp: new Date().toISOString(),
      type,
      ...(data ? { data } : {}),
    };
    try {
      const paths = ensureRuntimeDir(this.rootDir);
      appendFileSync(paths.eventLogFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // EACCES or other FS error — silently degrade. Event log is non-critical.
    }
    return entry;
  }
}

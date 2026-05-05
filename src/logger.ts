/**
 * Logger — central logging for ACP agent interactions.
 */
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Logger {
  info(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

/** No-op logger — all methods do nothing */
export function createNoopLogger(): Logger {
  return {
    info() {},
    error() {},
    debug() {},
  };
}

/** File logger — writes JSON lines to a log directory */
export function createFileLogger(logsDir: string, sessionId?: string): Logger {
  if (!existsSync(logsDir)) {
    try {
      mkdirSync(logsDir, { recursive: true });
    } catch (err) {
      console.log("[acp-logger] failed to create logsDir:", err);
    }
  }

  const mainLogPath = join(logsDir, "main.log");

  function write(level: string, msg: string, data?: unknown): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...(data !== undefined ? { data } : {}),
    };
    try {
      appendFileSync(mainLogPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.log("[acp-logger] failed to write main log:", err);
    }
  }

  if (sessionId) {
    const sessionDir = join(logsDir, sessionId);
    if (!existsSync(sessionDir)) {
      try {
        mkdirSync(sessionDir, { recursive: true });
      } catch (err) {
        console.log("[acp-logger] failed to create sessionDir:", err);
      }
    }
    const tracePath = join(sessionDir, "trace.jsonl");

    return {
      info(msg, data) {
        write("info", msg, data);
        try {
          appendFileSync(tracePath, JSON.stringify({ timestamp: new Date().toISOString(), level: "info", msg, data }) + "\n", "utf-8");
        } catch (err) {
          console.log("[acp-logger] failed to write trace:", err);
        }
      },
      error(msg, data) {
        write("error", msg, data);
        try {
          appendFileSync(tracePath, JSON.stringify({ timestamp: new Date().toISOString(), level: "error", msg, data }) + "\n", "utf-8");
        } catch (err) {
          console.log("[acp-logger] failed to write trace:", err);
        }
      },
      debug(msg, data) {
        write("debug", msg, data);
        try {
          appendFileSync(tracePath, JSON.stringify({ timestamp: new Date().toISOString(), level: "debug", msg, data }) + "\n", "utf-8");
        } catch (err) {
          console.log("[acp-logger] failed to write trace:", err);
        }
      },
    };
  }

  return {
    info(msg, data) { write("info", msg, data); },
    error(msg, data) { write("error", msg, data); },
    debug(msg, data) { write("debug", msg, data); },
  };
}

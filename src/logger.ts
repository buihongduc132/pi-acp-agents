/**
 * Logger — central logging for ACP agent interactions.
 */
import { mkdirSync, appendFileSync, existsSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

/** No-op logger — all methods do nothing */
export function createNoopLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

/**
 * Defense-in-depth log size guard (HOTFIX — 152GB log regression).
 *
 * If a runaway process (e.g. the wake-subscriber hot reconnect loop before the
 * fix) writes to main.log in a tight loop, the file can grow unbounded and fill
 * the disk. This cap triggers a one-shot truncate when the log exceeds the
 * threshold, then resets the counter so we don't stat() on every write (the
 * check runs at most once per LOG_SIZE_CHECK_INTERVAL writes).
 *
 * This is a SAFETY NET, not the primary fix — the primary fix is preventing the
 * hot loop at the source (wake-subscriber backoff + cap + log rate-limit).
 */
const LOG_SIZE_CAP_BYTES = 100 * 1024 * 1024; // 100 MB
const LOG_SIZE_CHECK_INTERVAL = 10_000; // stat() every N writes

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

  // Size-guard state — shared across all write() calls for this logger.
  let writeCountSinceLastSizeCheck = 0;

  function checkAndEnforceCap(): void {
    writeCountSinceLastSizeCheck++;
    if (writeCountSinceLastSizeCheck < LOG_SIZE_CHECK_INTERVAL) return;
    writeCountSinceLastSizeCheck = 0;
    try {
      const st = statSync(mainLogPath);
      if (st.size > LOG_SIZE_CAP_BYTES) {
        // Rotate: keep the most recent 1MB of log lines (tail), drop the rest.
        // Uses a STREAMING tail read (open + read at offset) instead of
        // readFileSync — reading a 100MB+ (or in production, 152GB) file into
        // a single string would be a memory bomb. This reads only the last 1MB.
        const tailBytes = 1024 * 1024; // 1 MB
        const readLen = Math.min(tailBytes, st.size);
        const offset = Math.max(0, st.size - tailBytes);
        let fd: number | null = null;
        try {
          fd = openSync(mainLogPath, "r");
          const buf = Buffer.alloc(readLen);
          readSync(fd, buf, 0, readLen, offset);
          closeSync(fd);
          fd = null;
          const tail = buf.toString("utf-8");
          const marker = JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            msg: `[acp-logger] main.log exceeded ${LOG_SIZE_CAP_BYTES} bytes — rotated (kept last 1MB, size guard)`,
          }) + "\n";
          writeFileSync(mainLogPath, marker + tail, "utf-8");
        } catch {
          // Fallback: write a fresh file if the rotate read failed.
          if (fd !== null) {
            try { closeSync(fd); } catch { /* ignore */ }
          }
          writeFileSync(
            mainLogPath,
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "warn",
              msg: `[acp-logger] main.log exceeded ${LOG_SIZE_CAP_BYTES} bytes — reset (size guard, rotate read failed)`,
            }) + "\n",
            "utf-8",
          );
        }
      }
    } catch {
      // stat failure is non-fatal — logging must never throw.
    }
  }

  function write(level: string, msg: string, data?: unknown): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...(data !== undefined ? { data } : {}),
    };
    try {
      appendFileSync(mainLogPath, JSON.stringify(entry) + "\n", "utf-8");
      checkAndEnforceCap();
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
      warn(msg, data) {
        write("warn", msg, data);
        try {
          appendFileSync(tracePath, JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", msg, data }) + "\n", "utf-8");
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
    warn(msg, data) { write("warn", msg, data); },
    error(msg, data) { write("error", msg, data); },
    debug(msg, data) { write("debug", msg, data); },
  };
}

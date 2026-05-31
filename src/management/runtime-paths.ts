import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AcpRuntimePaths {
  rootDir: string;
  tasksFile: string;
  mailboxesFile: string;
  governanceFile: string;
  eventLogFile: string;
  sessionArchiveFile: string;
  sessionNameRegistryFile: string;
  workersFile: string;
}

export function getRuntimePaths(rootDir?: string): AcpRuntimePaths {
  const base = rootDir ?? join(homedir(), ".pi", "acp-agents", "runtime");
  return {
    rootDir: base,
    tasksFile: join(base, "tasks.json"),
    mailboxesFile: join(base, "mailboxes.json"),
    governanceFile: join(base, "governance.json"),
    eventLogFile: join(base, "events.jsonl"),
    sessionArchiveFile: join(base, "session-archive.json"),
    sessionNameRegistryFile: join(base, "session-name-registry.json"),
    workersFile: join(base, "workers.json"),
  };
}

export function ensureRuntimeDir(rootDir?: string): AcpRuntimePaths {
  const paths = getRuntimePaths(rootDir);
  mkdirSync(paths.rootDir, { recursive: true, mode: 0o755 });
  // Detect root-owned dir (e.g. from sudo test run) — we can't chown from userspace,
  // but we can warn clearly instead of silently failing later with EACCES.
  try {
    const stat = statSync(paths.rootDir);
    const { uid: currentUid } = process;
    if (stat.uid !== currentUid) {
      console.warn(
        `[pi-acp-agents] WARNING: Runtime dir ${paths.rootDir} is owned by uid ${stat.uid}, but pi runs as uid ${currentUid}. ` +
        `Fix: sudo chown -R $(whoami) ${paths.rootDir}`
      );
    }
  } catch {
    // stat failed — dir may not exist yet, harmless
  }
  return paths;
}

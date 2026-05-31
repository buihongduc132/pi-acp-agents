import { mkdirSync, chmodSync } from "node:fs";
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
  // Ensure writable even if previously created by root (e.g. via sudo test run)
  try {
    chmodSync(paths.rootDir, 0o755);
  } catch {
    // EPERM — not owner, but still usable if permissions already allow
  }
  return paths;
}

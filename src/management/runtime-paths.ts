import { safeMkdir } from "./safe-mkdir.js";
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

export function getRuntimePaths(rootDir?: string, sessionId?: string): AcpRuntimePaths {
  const base = rootDir ?? join(homedir(), ".pi", "acp-agents", "runtime");
  const sessionBase = sessionId ? join(base, sessionId) : base;
  return {
    rootDir: base,
    tasksFile: join(sessionBase, "tasks.json"),
    mailboxesFile: join(sessionBase, "mailboxes.json"),
    governanceFile: join(sessionBase, "governance.json"),
    eventLogFile: join(base, "events.jsonl"),
    sessionArchiveFile: join(base, "session-archive.json"),
    sessionNameRegistryFile: join(base, "session-name-registry.json"),
    workersFile: join(sessionBase, "workers.json"),
  };
}

export function ensureRuntimeDir(rootDir?: string, sessionId?: string): AcpRuntimePaths {
  const paths = getRuntimePaths(rootDir, sessionId);
  safeMkdir(paths.rootDir);
  if (sessionId) {
    const sessionBase = join(paths.rootDir, sessionId);
    safeMkdir(sessionBase);
  }
  return paths;
}

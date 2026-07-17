import { safeMkdir } from "./safe-mkdir.js";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the pi config agent dir — honors PI_CODING_AGENT_DIR override.
 * Falls back to ~/.pi/agent.
 */
export function getPiAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override && override.trim() !== "") return override;
	return join(homedir(), ".pi", "agent");
}

/**
 * Resolve the shared child-usage sink directory.
 *
 * Precedence (first wins):
 *   1. explicit override arg (tests)
 *   2. PI_ACP_CHILD_USAGE_DIR env (test/dev override)
 *   3. <piAgentDir>/child-usage   (PI_CODING_AGENT_DIR or ~/.pi/agent)
 */
export function getChildUsageDir(explicit?: string): string {
	if (explicit && explicit.trim() !== "") return explicit;
	const env = process.env.PI_ACP_CHILD_USAGE_DIR;
	if (env && env.trim() !== "") return env;
	return join(getPiAgentDir(), "child-usage");
}

export interface AcpRuntimePaths {
  rootDir: string;
  tasksFile: string;
  mailboxesFile: string;
  governanceFile: string;
  eventLogFile: string;
  sessionArchiveFile: string;
  sessionNameRegistryFile: string;
  workersFile: string;
  /** Directory holding DAG state files (`<dagId>.json` + `dag-index.json`). */
  dagDir: string;
  /** Index file tracking all DAGs with summary status. */
  dagIndexFile: string;
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
    dagDir: join(base, "dag"),
    dagIndexFile: join(base, "dag", "dag-index.json"),
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

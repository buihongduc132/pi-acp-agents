/**
 * pi-acp-agents — Session manager
 *
 * Simple add/get/remove/list/disposeAll for AcpSessionHandle objects.
 */
import type { AcpSessionHandle } from "../config/types.js";
import { getSessionPruneReason } from "./session-lifecycle.js";

export interface SessionPruneResult {
  removedSessionIds: string[];
}

export class SessionManager {
  private sessions = new Map<string, AcpSessionHandle>();

  add(handle: AcpSessionHandle): void {
    this.sessions.set(handle.sessionId, handle);
  }

  get(sessionId: string): AcpSessionHandle | undefined {
    return this.sessions.get(sessionId);
  }

  list(): AcpSessionHandle[] {
    return Array.from(this.sessions.values());
  }

  listByAgent(agentName?: string): AcpSessionHandle[] {
    return this.list().filter((session) => !agentName || session.agentName === agentName);
  }

  async remove(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle) {
      try {
        await handle.dispose();
      } catch (err) {
        console.error("[acp] dispose error:", err);
      }
      this.sessions.delete(sessionId);
    }
  }

  async disposeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.remove(id);
    }
  }

  async pruneStale(maxIdleMs: number, now = Date.now()): Promise<SessionPruneResult> {
    const removedSessionIds: string[] = [];
    for (const session of this.list()) {
      if (!getSessionPruneReason(session, maxIdleMs, now)) continue;
      removedSessionIds.push(session.sessionId);
      await this.remove(session.sessionId);
    }
    return { removedSessionIds };
  }

  get size(): number {
    return this.sessions.size;
  }
}

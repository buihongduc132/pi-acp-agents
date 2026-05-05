/**
 * pi-acp-agents — Session manager
 *
 * Simple add/get/remove/list/disposeAll for AcpSessionHandle objects.
 */
import type { AcpSessionHandle } from "../config/types.js";

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

  get size(): number {
    return this.sessions.size;
  }
}

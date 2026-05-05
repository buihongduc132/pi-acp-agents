/**
 * Health monitor — tracks session staleness, polls periodically.
 */

export interface HealthMonitorable {
  sessionId: string;
  lastActivityAt: Date;
  disposed: boolean;
}

export interface HealthMonitorOptions {
  intervalMs: number;
  staleTimeoutMs: number;
  onStale?: (sessionId: string) => void | Promise<void>;
}

interface TrackedEntry {
  session: HealthMonitorable;
}

export class HealthMonitor {
  private entries = new Map<string, TrackedEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private opts: HealthMonitorOptions;

  constructor(opts: HealthMonitorOptions) {
    this.opts = opts;
  }

  get size(): number {
    return this.entries.size;
  }

  get running(): boolean {
    return this._running;
  }

  register(session: HealthMonitorable): void {
    this.entries.set(session.sessionId, { session });
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  isStale(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    return Date.now() - entry.session.lastActivityAt.getTime() > this.opts.staleTimeoutMs;
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.session.lastActivityAt = new Date();
    }
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.timer = setInterval(async () => {
      const staleIds = await this.check();
      if (this.opts.onStale) {
        for (const id of staleIds) {
          try {
            await this.opts.onStale(id);
          } catch (err) {
            console.error("[acp-health] onStale callback error:", err);
          }
        }
      }
    }, this.opts.intervalMs);
  }

  stop(): void {
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<string[]> {
    const staleIds: string[] = [];
    const toRemove: string[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.session.disposed) {
        toRemove.push(id);
        continue;
      }
      if (Date.now() - entry.session.lastActivityAt.getTime() > this.opts.staleTimeoutMs) {
        staleIds.push(id);
      }
    }

    for (const id of toRemove) {
      this.entries.delete(id);
    }

    return staleIds;
  }
}

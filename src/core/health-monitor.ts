/**
 * Health monitor — tracks ACP session lifecycle auto-close policies, polls periodically.
 *
 * Two detection layers:
 * 1. Idle/stale detection (existing): disposes sessions with no activity after staleTimeoutMs.
 * 2. Prompt stall detection (new): detects active prompts with no streaming chunks,
 *    emits needs-attention notification, then auto-interrupts if still idle.
 */

import { getSessionAutoCloseReason } from "./session-lifecycle.js";

export interface HealthMonitorable {
  sessionId: string;
  lastActivityAt: Date;
  lastResponseAt?: Date;
  completedAt?: Date;
  busy?: boolean;
  disposed: boolean;
  /** True while a prompt() call is in-flight */
  isPrompting?: boolean;
  /** Timestamp when the current prompt started */
  promptStartedAt?: Date;
}

/** Prompt stall reason — activity-based, separate from idle auto-close */
export type PromptStallReason = "slow-prompt" | "stalled-prompt";

export interface HealthMonitorOptions {
  intervalMs: number;
  staleTimeoutMs: number;
  /** Idle threshold (ms) before emitting needs-attention for active prompts. Default: 60_000 */
  needsAttentionMs?: number;
  /** Idle threshold (ms) before auto-interrupting stalled prompts. Default: 300_000, 0 = disabled */
  autoInterruptMs?: number;
  /** Grace period (ms) after cancel before force-kill. Default: 10_000 */
  interruptGraceMs?: number;
  onStale?: (sessionId: string) => void | Promise<void>;
  /** Called when a prompt has been idle > needsAttentionMs but < autoInterruptMs. Notification only. */
  onNeedsAttention?: (sessionId: string) => void | Promise<void>;
  /** Called when a prompt is auto-interrupted (stalled-prompt). index.ts handles cancel → kill. */
  onInterrupt?: (sessionId: string) => void | Promise<void>;
}

interface TrackedEntry {
  session: HealthMonitorable;
  /** Track whether we already notified for this stall cycle (reset on next touch) */
  attentionNotified: boolean;
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
    this.entries.set(session.sessionId, { session, attentionNotified: false });
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  isStale(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    return this.getStaleReason(entry.session) !== undefined;
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.session.lastActivityAt = new Date();
      entry.attentionNotified = false;
    }
  }

  /** Mark that a prompt() call has started for this session */
  markPromptStart(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.session.isPrompting = true;
      entry.session.promptStartedAt = new Date();
      entry.attentionNotified = false;
    }
  }

  /** Mark that the prompt() call has ended (completed or threw) */
  markPromptEnd(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.session.isPrompting = false;
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

      // Check idle/stale detection (existing)
      if (this.getStaleReason(entry.session)) {
        staleIds.push(id);
        continue;
      }

      // Check prompt stall detection (new) — only for active prompts
      const stallReason = this.getPromptStallReason(entry.session);
      if (stallReason === "slow-prompt") {
        // Emit notification once per stall cycle (reset on touch)
        if (!entry.attentionNotified && this.opts.onNeedsAttention) {
          entry.attentionNotified = true;
          try {
            await this.opts.onNeedsAttention(id);
          } catch (err) {
            console.error("[acp-health] onNeedsAttention callback error:", err);
          }
        }
        // Don't add to staleIds — this is notification only
        continue;
      }
      if (stallReason === "stalled-prompt") {
        staleIds.push(id);
        continue;
      }
    }

    for (const id of toRemove) {
      this.entries.delete(id);
    }

    return staleIds;
  }

  private getStaleReason(session: HealthMonitorable): "stalled-no-response" | "completed-idle" | undefined {
    return getSessionAutoCloseReason(session, this.opts.staleTimeoutMs);
  }

  /**
   * Check if an active prompt has been idle too long.
   * Uses lastActivityAt (updated by touch() via onActivity callback) as the activity signal.
   */
  private getPromptStallReason(session: HealthMonitorable): PromptStallReason | undefined {
    const autoInterruptMs = this.opts.autoInterruptMs ?? 300_000;
    if (autoInterruptMs === 0) return undefined; // disabled
    if (!session.isPrompting) return undefined;

    const now = Date.now();
    const idleMs = now - session.lastActivityAt.getTime();

    if (idleMs > autoInterruptMs) return "stalled-prompt";

    const needsAttentionMs = this.opts.needsAttentionMs ?? 60_000;
    if (idleMs > needsAttentionMs) return "slow-prompt";

    return undefined;
  }
}

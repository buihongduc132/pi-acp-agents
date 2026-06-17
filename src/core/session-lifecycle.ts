import type { AcpSessionHandle } from "../config/types.js";
import type { HealthMonitorable } from "./health-monitor.js";

export type SessionAutoCloseReason = "stalled-no-response" | "completed-idle";

export interface SessionLifecycleState {
  disposed: boolean;
  busy?: boolean;
  lastResponseAt?: Date;
  completedAt?: Date;
}

export function getSessionAutoCloseReason(
  session: SessionLifecycleState,
  timeoutMs: number,
  now = Date.now(),
  completedIdleTtlMs: number = timeoutMs,
): SessionAutoCloseReason | undefined {
  if (session.busy) {
    if (!session.lastResponseAt) return undefined;
    return now - session.lastResponseAt.getTime() > timeoutMs
      ? "stalled-no-response"
      : undefined;
  }

  if (!session.completedAt) return undefined;
  // Completed (non-busy) idle sessions are reaped on their own, shorter TTL —
  // independent of the long stall `timeoutMs` used for busy sessions.
  return now - session.completedAt.getTime() > completedIdleTtlMs
    ? "completed-idle"
    : undefined;
}

export function isSessionAutoClosable(
  session: SessionLifecycleState,
  timeoutMs: number,
  now = Date.now(),
  completedIdleTtlMs: number = timeoutMs,
): boolean {
  return getSessionAutoCloseReason(session, timeoutMs, now, completedIdleTtlMs) !== undefined;
}

export function getSessionPruneReason(
  session: Pick<AcpSessionHandle | HealthMonitorable, "disposed" | "busy" | "lastResponseAt" | "completedAt">,
  timeoutMs: number,
  now = Date.now(),
  completedIdleTtlMs: number = timeoutMs,
): "disposed" | SessionAutoCloseReason | undefined {
  if (session.disposed) return "disposed";
  return getSessionAutoCloseReason(session, timeoutMs, now, completedIdleTtlMs);
}

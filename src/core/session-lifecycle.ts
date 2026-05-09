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
): SessionAutoCloseReason | undefined {
  if (session.busy) {
    if (!session.lastResponseAt) return undefined;
    return now - session.lastResponseAt.getTime() > timeoutMs
      ? "stalled-no-response"
      : undefined;
  }

  if (!session.completedAt) return undefined;
  return now - session.completedAt.getTime() > timeoutMs
    ? "completed-idle"
    : undefined;
}

export function isSessionAutoClosable(
  session: SessionLifecycleState,
  timeoutMs: number,
  now = Date.now(),
): boolean {
  return getSessionAutoCloseReason(session, timeoutMs, now) !== undefined;
}

export function getSessionPruneReason(
  session: Pick<AcpSessionHandle | HealthMonitorable, "disposed" | "busy" | "lastResponseAt" | "completedAt">,
  timeoutMs: number,
  now = Date.now(),
): "disposed" | SessionAutoCloseReason | undefined {
  if (session.disposed) return "disposed";
  return getSessionAutoCloseReason(session, timeoutMs, now);
}

/**
 * ACP TUI Widget — persistent panel for ACP agent status
 *
 * Renders in pi's TUI status area, similar to pi-agent-teams widget.
 * Shows: header, circuit breaker state, per-session rows, totals, hints.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AcpSessionHandle } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────

export type AcpSessionStatus = "active" | "idle" | "stale" | "error";

export interface AcpWidgetSession {
	sessionId: string;
	agentName: string;
	cwd: string;
	status: AcpSessionStatus;
	lastActivityAt: Date;
	createdAt: Date;
	model?: string;
}

export interface AcpWidgetState {
	sessions: AcpWidgetSession[];
	circuitBreakerState: "closed" | "open" | "half-open";
	configuredAgentNames: string[];
	defaultAgent?: string;
}

// ── Status styling ──────────────────────────────────────────────────

const STATUS_ICON: Record<AcpSessionStatus, string> = {
	active: "●",
	idle: "○",
	stale: "◻",
	error: "✕",
};

const STATUS_COLOR: Record<AcpSessionStatus, ThemeColor> = {
	active: "success",
	idle: "muted",
	stale: "warning",
	error: "error",
};

const CB_ICON: Record<string, { icon: string; color: ThemeColor }> = {
	closed: { icon: "●", color: "success" },
	open: { icon: "✕", color: "error" },
	"half-open": { icon: "◐", color: "warning" },
};

// ── Helpers ─────────────────────────────────────────────────────────

/** Pad a string to a visible width, accounting for ANSI escape codes. */
function padRight(text: string, width: number): string {
	const vw = visibleWidth(text);
	return vw >= width ? text : text + " ".repeat(width - vw);
}

/** Format token count with K/M suffix. */
function formatTokens(count: number): string {
	if (count === 0) return "0";
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
	return String(count);
}

/** Short session ID — first 8 chars. */
function shortId(id: string): string {
	return id.length <= 8 ? id : id.slice(0, 8) + "…";
}

/** Time ago string. */
function timeAgo(date: Date): string {
	const ms = Date.now() - date.getTime();
	if (ms < 5_000) return "just now";
	if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ── Widget factory ──────────────────────────────────────────────────

export type AcpWidgetDeps = {
	getState(): AcpWidgetState;
};

export type AcpWidgetFactory = (
	tui: unknown,
	theme: Theme,
) => Component & { dispose?(): void };

export function createAcpWidget(deps: AcpWidgetDeps): AcpWidgetFactory {
	return (_tui: unknown, theme: Theme): Component & { dispose?(): void } => {
		// Refresh every 5s to update "time ago" displays
		const refreshInterval = setInterval(() => {
			// No-op; the widget is re-rendered on each TUI paint cycle
			// via the closure over deps.getState()
		}, 5_000);

		return {
			render(width: number): string[] {
				const state = deps.getState();

				// Hide when no sessions and no configured agents
				if (
					state.sessions.length === 0 &&
					state.configuredAgentNames.length === 0
				) {
					return [];
				}

				const lines: string[] = [];

				// ── Header ──
				const header = " " + theme.bold(theme.fg("accent", "ACP Agents"));
				lines.push(truncateToWidth(header, width));

				// ── Circuit breaker state (only show if not closed) ──
				if (state.circuitBreakerState !== "closed") {
					const cb = CB_ICON[state.circuitBreakerState] ?? CB_ICON["open"];
					const cbLabel =
						state.circuitBreakerState === "half-open"
							? "half-open (probing)"
							: state.circuitBreakerState;
					lines.push(
						truncateToWidth(
							` ${theme.fg(cb.color, `${cb.icon} circuit breaker: ${cbLabel}`)}`,
							width,
						),
					);
				}

				// ── No sessions ──
				if (state.sessions.length === 0) {
					const agentList = state.configuredAgentNames.join(", ") || "none";
					lines.push(
						truncateToWidth(
							` ${theme.fg("dim", `(no active sessions)  agents: ${agentList}`)}`,
							width,
						),
					);
					lines.push(
						truncateToWidth(
							theme.fg("dim", " /acp-config · acp_prompt <msg>"),
							width,
						),
					);
					return lines;
				}

				// ── Build rows ──
				// Compute column widths
				const nameWidth = Math.max(
					...state.sessions.map((s) => visibleWidth(s.agentName)),
					8, // minimum
				);
				const idWidth = 8; // short session ID

				for (const session of state.sessions) {
					const icon = theme.fg(
						STATUS_COLOR[session.status],
						STATUS_ICON[session.status],
					);
					const name = theme.bold(padRight(session.agentName, nameWidth));
					const id = theme.fg(
						"dim",
						shortId(session.sessionId).padEnd(idWidth),
					);
					const statusLabel = theme.fg(
						STATUS_COLOR[session.status],
						padRight(session.status, 7),
					);
					const modelLabel = session.model
						? ` ${theme.fg("muted", session.model)}`
						: "";
					const activity = theme.fg("dim", timeAgo(session.lastActivityAt));

					const row = ` ${icon} ${name} ${id} ${statusLabel}${modelLabel} · ${activity}`;
					lines.push(truncateToWidth(row, width));
				}

				// ── Separator + Summary ──
				lines.push(
					truncateToWidth(
						" " + theme.fg("dim", "─".repeat(Math.max(0, width - 2))),
						width,
					),
				);

				const totalActive = state.sessions.filter(
					(s) => s.status === "active",
				).length;
				const totalIdle = state.sessions.filter(
					(s) => s.status === "idle",
				).length;
				const totalStale = state.sessions.filter(
					(s) => s.status === "stale",
				).length;
				const totalSessions = state.sessions.length;

				const summaryParts: string[] = [
					`${totalSessions} session${totalSessions !== 1 ? "s" : ""}`,
				];
				if (totalActive > 0) summaryParts.push(`${totalActive} active`);
				if (totalIdle > 0) summaryParts.push(`${totalIdle} idle`);
				if (totalStale > 0) summaryParts.push(`${totalStale} stale`);

				const agentsConfigured = state.configuredAgentNames.length;
				const defaultLabel = state.defaultAgent
					? ` · default: ${state.defaultAgent}`
					: "";

				lines.push(
					truncateToWidth(
						` ${theme.fg("muted", summaryParts.join(" · "))}  ${theme.fg("dim", `${agentsConfigured} agent${agentsConfigured !== 1 ? "s" : ""} configured${defaultLabel}`)}`,
						width,
					),
				);

				// ── Hints ──
				lines.push(
					truncateToWidth(
						theme.fg("dim", " /acp-config · acp_status · acp_prompt <msg>"),
						width,
					),
				);

				return lines;
			},

			invalidate() {},

			dispose() {
				clearInterval(refreshInterval);
			},
		};
	};
}

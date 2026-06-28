/**
 * ACP TUI Widget — persistent panel for ACP agent status
 *
 * Renders in pi's TUI status area, similar to pi-agent-teams widget.
 * Compact format: 1 header line (with inline CB state + session summary)
 * + up to 4 session rows (overflow collapsed into last row)
 * + DAG progress section (when DAGs are active).
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { DagIndexEntry } from "./config/types.js";

// ── Types ──────────────────────────────────────────────────────────

/** DAG lifecycle status. Mirrors `DagStore` / `DagIndexEntry` status values. */
export type DagStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "stale";

/**
 * DAG summary row for the ACP widget.
 *
 * Mapped from `DagIndexEntry` (see `index.ts` wiring): `totalSteps` → `total`,
 * `completedSteps` → `completed`, `failedSteps` → `failed`. Wave info is
 * optional since the index entry doesn't always carry it.
 */
export interface AcpWidgetDag {
	dagId: string;
	status: DagStatus;
	total: number;
	completed: number;
	failed: number;
	cancelled: number;
	currentWave?: number;
	totalWaves?: number;
	createdAt: Date;
	updatedAt: Date;
}

export type AcpSessionStatus = "active" | "idle" | "stale" | "error";

export interface AcpWidgetSession {
	sessionId: string;
	sessionName?: string;
	agentName: string;
	cwd: string;
	status: AcpSessionStatus;
	lastActivityAt: Date;
	createdAt: Date;
	model?: string;
}

export interface AcpWidgetDelegation {
	id: string;
	agentName: string;
	phase: string;
	startedAt: Date;
	lastActivityAt: Date;
	text?: string;
}

export interface AcpDelegationHistoryEntry {
	agentName: string;
	status: "completed" | "error";
	error?: string;
	sessionId?: string;
	finishedAt: Date;
}

export interface AcpWidgetActivity {
	activeDelegations: number;
	activeBroadcasts: number;
	activeCompares: number;
	delegations: AcpWidgetDelegation[];
	/** Capped at 20 entries — most recent last. */
	delegationHistory?: AcpDelegationHistoryEntry[];
	lastError?: string;
}

export interface AcpWidgetWorker {
	name: string;
	agentName: string;
	status: string;
	tokenCountTotal: number;
	toolCallCount: number;
	ageSeconds: number;
	stale: boolean;
	currentTaskId?: string;
}

export interface AcpWidgetState {
	sessions: AcpWidgetSession[];
	circuitBreakerState: "closed" | "open" | "half-open";
	configuredAgentNames: string[];
	configuredAliases?: string[];
	defaultAgent?: string;
	activity: AcpWidgetActivity;
	workers?: AcpWidgetWorker[];
	/** DAG progress rows, populated from `DagStore.listAll()` in `getWidgetState()`. Optional for backwards-compat with fixtures that predate DAGs. */
	dags?: AcpWidgetDag[];
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

/**
 * DAG status → `{ icon, color }` styling. Reuses the existing widget palette
 * (`success`/`warning`/`error`/`muted`/`dim`/`accent`) — no new colors introduced.
 */
export const DAG_STATUS_ICON: Record<DagStatus, { icon: string; color: ThemeColor }> = {
	running: { icon: "●", color: "accent" },
	completed: { icon: "✓", color: "success" },
	failed: { icon: "✕", color: "error" },
	cancelled: { icon: "◻", color: "dim" },
	pending: { icon: "·", color: "muted" },
	stale: { icon: "◻", color: "warning" },
};

const WORKER_STATUS_ICON: Record<string, { icon: string; color: ThemeColor }> = {
	online: { icon: "●", color: "success" },
	idle: { icon: "○", color: "muted" },
	busy: { icon: "●", color: "accent" },
	offline: { icon: "✕", color: "dim" },
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

/**
 * Format a DAG progress bar.
 *
 * Filled blocks (`█`) = `completed + failed`; empty blocks (`░`) = the
 * remainder up to the bar width (`min(total, 8)`). When `total === 0` returns
 * an empty string (no progress to show).
 */
export function formatProgress(
	completed: number,
	failed: number,
	total: number,
): string {
	if (total <= 0) return "";
	const width = Math.min(total, 8);
	const filled = Math.max(0, Math.min(completed + failed, width));
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	return `[${bar}] ${completed}/${total}`;
}

/**
 * Map a persisted `DagIndexEntry` (summary row from `dag-index.json`) into an
 * `AcpWidgetDag` row for the TUI widget.
 *
 * This is the single authoritative place where the two shapes are bridged.
 * Field-name remapping:
 *
 *   DagIndexEntry      → AcpWidgetDag
 *   ────────────────────────────────────────────
 *   dagId              → dagId            (identity)
 *   status             → status           (identity)
 *   totalSteps         → total            (RENAMED)
 *   completedSteps     → completed        (RENAMED)
 *   failedSteps        → failed           (RENAMED)
 *   (absent)           → cancelled = 0    (index carries no cancelled count)
 *   (absent)           → currentWave?     (index carries no wave info → undefined)
 *   (absent)           → totalWaves?      (index carries no wave info → undefined)
 *   createdAt: string  → createdAt: Date  (ISO → Date)
 *   updatedAt: string  → updatedAt: Date  (ISO → Date)
 */
export function dagIndexEntryToWidgetDag(entry: DagIndexEntry): AcpWidgetDag {
	return {
		dagId: entry.dagId,
		status: entry.status,
		total: entry.totalSteps,
		completed: entry.completedSteps,
		failed: entry.failedSteps,
		cancelled: 0,
		currentWave: undefined,
		totalWaves: undefined,
		createdAt: new Date(entry.createdAt),
		updatedAt: new Date(entry.updatedAt),
	};
}

/**
 * Render a single DAG summary row (plain text — no theme coloring).
 *
 * Format: `<icon> <dagId> <progress> wave <w>/<totalW> <age> [fail:<failed>]`
 *  - the `wave <w>/<totalW>` segment is omitted when `totalWaves` is absent
 *  - the `[fail:<failed>]` segment is omitted when `failed === 0`
 */
export function renderDagRow(dag: AcpWidgetDag): string {
	const icon = DAG_STATUS_ICON[dag.status]?.icon ?? "○";
	const parts: string[] = [icon, dag.dagId];

	const progress = formatProgress(dag.completed, dag.failed, dag.total);
	if (progress) parts.push(progress);

	if (dag.totalWaves !== undefined) {
		parts.push(`wave ${dag.currentWave ?? 0}/${dag.totalWaves}`);
	}

	parts.push(timeAgo(dag.updatedAt));

	if (dag.failed > 0) {
		parts.push(`[fail:${dag.failed}]`);
	}

	return parts.join(" ");
}

/**
 * Render a collapsed one-line summary of recent DAGs.
 *
 * Each entry renders as `<dagId>:<icon>` joined by single spaces. The list is
 * capped at 5 entries (preserving input order) to keep the widget bounded.
 */
export function renderDagSummary(dags: AcpWidgetDag[]): string {
	return dags
		.slice(0, 5)
		.map((dag) => `${dag.dagId}:${DAG_STATUS_ICON[dag.status]?.icon ?? "○"}`)
		.join(" ");
}

/**
 * Render the full DAG section for the widget state.
 *
 * Decision rules:
 *  - When `dags` is absent or empty → return `""` (no DAG section rendered).
 *  - When any DAG has `status === "running"` → return one `renderDagRow` line per
 *    entry (joined by `\n`), so users get live per-DAG progress.
 *  - Otherwise (no running DAGs but some completed/failed/cancelled) → return a
 *    collapsed `renderDagSummary` of the recent DAGs, capped at 5 entries.
 *
 * `pending` DAGs never contribute a row (they carry no progress worth surfacing).
 */
export function renderDagSection(state: AcpWidgetState): string {
	const dags = state.dags;
	if (!dags || dags.length === 0) return "";

	const visible = dags.filter((d) => d.status !== "pending");
	if (visible.length === 0) return "";

	// Cap the render list at 5 entries, ordered by `updatedAt` descending
	const recent = [...visible]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, 5);

	if (recent.some((d) => d.status === "running")) {
		return recent.map(renderDagRow).join("\n");
	}

	return renderDagSummary(recent);
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

				// Hide when nothing to show
				const hasWorkers = (state.workers?.length ?? 0) > 0;
				const hasDags = (state.dags?.length ?? 0) > 0;
				if (
					state.sessions.length === 0 &&
					state.configuredAgentNames.length === 0 &&
					!hasWorkers &&
					!hasDags
				) {
					return [];
				}

				const lines: string[] = [];

				// ── Compact header ──
				// Build CB suffix
				const cbSuffix =
					state.circuitBreakerState === "open"
						? " ⚠ CB:open"
						: state.circuitBreakerState === "half-open"
							? " ⚠ CB:half-open"
							: "";
				const cbColored = cbSuffix
					? theme.fg("error", cbSuffix)
					: "";

				// Build session summary
				let sessionSummary: string;
				if (state.sessions.length === 0) {
					sessionSummary = theme.fg("muted", "idle");
				} else {
					// Count sessions by status
					const counts: Record<AcpSessionStatus, number> = {
						active: 0, idle: 0, stale: 0, error: 0,
					};
					for (const s of state.sessions) counts[s.status]++;

					const parts: string[] = [];
					for (const status of ["active", "idle", "stale", "error"] as AcpSessionStatus[]) {
						if (counts[status] > 0) {
							parts.push(`${counts[status]} ${theme.fg(STATUS_COLOR[status], status)}`);
						}
					}
					sessionSummary = parts.join(" · ");
				}

				const header = ` ${theme.bold(theme.fg("accent", "◉"))} ACP${cbColored} ${sessionSummary}`;
				lines.push(truncateToWidth(header, width));

				// ── Session rows (max 4, overflow on last) ──
				if (state.sessions.length > 0) {
					const maxShow = 4;
					const sessions = state.sessions;
					const nameWidth = Math.max(
						...sessions.map((s) => visibleWidth(s.agentName)),
						8,
					);
					const overflow = Math.max(0, sessions.length - maxShow);
					const shown = sessions.slice(0, maxShow);

					for (let i = 0; i < shown.length; i++) {
						const session = shown[i];
						const icon = theme.fg(
							STATUS_COLOR[session.status],
							STATUS_ICON[session.status],
						);
						const name = padRight(session.agentName, nameWidth);
						const friendlyName = session.sessionName
							? ` ${theme.fg("accent", session.sessionName)}`
							: "";
						const id = theme.fg("dim", shortId(session.sessionId));
						const time = theme.fg("dim", timeAgo(session.lastActivityAt));

						let row = ` ${icon} ${name}${friendlyName} ${id} · ${time}`;

						// Append overflow count to last shown row
						if (overflow > 0 && i === shown.length - 1) {
							row += theme.fg("dim", ` +${overflow} more`);
						}

						lines.push(truncateToWidth(row, width));
					}
				}

				// ── DAG progress section ──
				const dagSection = renderDagSection(state);
				if (dagSection !== "") {
					lines.push(
						truncateToWidth(" " + theme.fg("dim", "─ DAGs ─"), width),
					);
					for (const dagLine of dagSection.split("\n")) {
						lines.push(truncateToWidth(` ${dagLine}`, width));
					}
				}

				// ── Worker rows (persistent workers) ──
				if (state.workers && state.workers.length > 0) {
					lines.push(
						truncateToWidth(
							" " + theme.fg("dim", "─ workers ─"),
							width,
						),
					);
					for (const w of state.workers) {
						const statusBase = w.status.startsWith("stale") ? "offline" : w.status;
						const wIcon = WORKER_STATUS_ICON[statusBase] ?? { icon: "○", color: "muted" as ThemeColor };
						const statusColor: ThemeColor = w.status.startsWith("stale") ? "warning" : wIcon.color;
						const staleIndicator = w.stale ? theme.fg("warning", " ⚠ stale") : "";
						const taskInfo = w.currentTaskId ? theme.fg("dim", ` · task=${w.currentTaskId}`) : "";
						const workerLine = ` ${theme.fg(statusColor, wIcon.icon)} ${theme.bold(w.name)}: ${theme.fg(statusColor, w.status)} · tok=${formatTokens(w.tokenCountTotal)} · tools=${w.toolCallCount} · ${w.ageSeconds}s ago${taskInfo}${staleIndicator}`;
						lines.push(truncateToWidth(workerLine, width));
					}
				}

				return lines;
			},

			invalidate() {},

			dispose() {
				clearInterval(refreshInterval);
			},
		};
	};
}

/**
 * Anti-flicker tests for ACP TUI Widget (acp-widget.ts) — R3 invariant
 *
 * These tests verify that the line count produced by render() is deterministic.
 *
 * COMPACT FORMAT (the current render contract, introduced by FN-008 / commit
 * 9db2abb — "Compact format: 1 header line with inline CB state + session
 * summary"). The widget renders:
 *   - 1 header line (ALWAYS, unless entirely hidden) — carries the CB state
 *     suffix, the session-count summary, and the activity lastError hint INLINE.
 *   - up to 4 session rows (overflow is noted INLINE on the 4th row via
 *     "+N more"; it does NOT add extra rows).
 *   - optional DAG section (1 header + N dag lines) — only when state.dags is
 *     non-empty.
 *   - optional workers section (1 header + N worker rows) — only when
 *     state.workers is non-empty.
 *
 * CRITICAL compact-format consequences for line-count determinism:
 *   - CB closed↔open↔half-open changes ONLY header text → line count is
 *     PRESERVED (the CB state is inline, no dedicated CB row).
 *   - Activity counters (activeDelegations/Broadcasts/Compares) and lastError
 *     are inline → line count PRESERVED.
 *   - The `delegations` and `delegationHistory` arrays are NOT rendered in
 *     compact format → they add NO rows. Toggling them PRESERVES line count.
 *   - Session status / session-name changes alter row TEXT only → PRESERVED.
 *   - Session count beyond 4 does NOT add rows (capped at 4).
 *
 * "Preserves line count" means two states that differ ONLY in text content
 * (not in row-affecting fields) render the same number of lines. The only
 * row-affecting fields in compact format are: the number of sessions (capped
 * at 4), presence of state.dags, and presence of state.workers.
 *
 * This file was realigned to the compact format after FN-008 switched render()
 * away from the legacy full format (header + status + separator + summary +
 * hints + dedicated CB/delegation/history rows). The full-format assertions
 * (separator line, hints line, ±1 on CB transitions) are no longer valid and
 * have been replaced by the equivalent compact-format invariant below.
 */
import { describe, expect, it } from "vitest";
import {
	type AcpWidgetDeps,
	type AcpWidgetState,
	type AcpWidgetSession,
	createAcpWidget,
} from "../src/acp-widget.js";

// ── Mock theme ──────────────────────────────────────────────────────

function createMockTheme() {
	return {
		fg: (_color: string, text: string) => `<${_color}>${text}</>`,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
	} as any;
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeSession(overrides: Partial<AcpWidgetSession> = {}): AcpWidgetSession {
	return {
		sessionId: "abc12345-6789-def0",
		agentName: "gemini",
		cwd: "/tmp",
		status: "active",
		lastActivityAt: new Date(),
		createdAt: new Date(),
		...overrides,
	};
}

function makeState(overrides: Partial<AcpWidgetState> = {}): AcpWidgetState {
	return {
		sessions: [],
		circuitBreakerState: "closed",
		configuredAgentNames: ["gemini"],
		activity: {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		},
		...overrides,
	};
}

function renderWidget(state: AcpWidgetState, width = 100): string[] {
	const deps: AcpWidgetDeps = { getState: () => state };
	const factory = createAcpWidget(deps);
	const widget = factory({}, createMockTheme());
	return widget.render(width);
}

/**
 * Deterministic line-count model mirroring the COMPACT render() in
 * acp-widget.ts.
 *
 *   hidden (0 lines) when: no sessions AND no configured agents AND no
 *   workers AND no dags.
 *
 *   Otherwise:
 *     1   header (always; carries CB state + session summary + lastError inline)
 *   + min(sessions.length, 4)   session rows (capped at 4; overflow is inline)
 *   + (dag section, only if state.dags non-empty — not exercised here)
 *   + (workers section, only if state.workers non-empty — not exercised here)
 *
 * NOTE: CB state, activity counters, lastError, delegations[], and
 * delegationHistory[] do NOT contribute rows in compact format — they only
 * alter header text. Hence toggling any of them preserves the line count.
 */
function expectedLineCount(state: AcpWidgetState): number {
	const hasWorkers = (state.workers?.length ?? 0) > 0;
	const hasDags = (state.dags?.length ?? 0) > 0;
	if (
		state.sessions.length === 0 &&
		state.configuredAgentNames.length === 0 &&
		!hasWorkers &&
		!hasDags
	) {
		return 0;
	}
	let n = 0;
	n += 1; // header (always rendered when not hidden)
	n += Math.min(state.sessions.length, 4); // session rows, capped at 4
	// DAG and workers sections are absent in every state built by makeState()
	// below (neither `dags` nor `workers` is set), so they contribute 0 here.
	return n;
}

// ── Category A: Static line-count verification ──────────────────────

describe("acp-widget anti-flicker — static line counts", () => {
	it("0 sessions + 0 agents → 0 lines (hidden)", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: [],
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		expect(lines.length).toBe(0);
	});

	it("0 sessions + configured agents → compact format count", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: ["gemini"],
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		// header only (0 session rows).
		expect(lines.length).toBe(1);
	});

	it("1 session → compact format count", () => {
		const state = makeState({
			sessions: [makeSession()],
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		// header + 1 session row.
		expect(lines.length).toBe(2);
	});

	it("2 sessions → compact format count", () => {
		const sessions = [
			makeSession({ sessionId: "s1", agentName: "gemini" }),
			makeSession({ sessionId: "s2", agentName: "claude" }),
		];
		const state = makeState({
			sessions,
			configuredAgentNames: ["gemini", "claude"],
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		expect(lines.length).toBe(3);
	});

	it("3 sessions → compact format count", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
	});

	it("4 sessions → compact format count (exactly at the cap)", () => {
		const sessions = Array.from({ length: 4 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		expect(lines.length).toBe(5); // header + 4 rows
	});

	it("5 sessions → compact format count (cap applies: +N more inline)", () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		// Still header + 4 rows; the 5th is folded into "+1 more" on row 4.
		expect(lines.length).toBe(5);
	});

	it("10 sessions → compact format count (cap applies: 6 hidden, inline)", () => {
		const sessions = Array.from({ length: 10 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		expect(lines.length).toBe(5); // header + 4 rows (6 folded inline)
	});

	it("100 sessions → compact format count (cap applies, 96 folded inline)", () => {
		const sessions = Array.from({ length: 100 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
		expect(lines.length).toBe(5); // header + 4 rows
	});
});

// ── Category B: Status transitions preserve line count ──────────────
// Status (idle/active/error/stale) only changes the session row's icon/text
// and the header's count summary — never the row count. So before.length ===
// after.length, and both equal the deterministic expectedLineCount(state).

describe("acp-widget anti-flicker — status transitions", () => {
	it("1 session: idle → active preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "idle" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.sessions[0].status = "active";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("1 session: active → error preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "active" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.sessions[0].status = "error";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("1 session: active → stale preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "active" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.sessions[0].status = "stale";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("2 sessions: both idle → both active preserves line count", () => {
		const state = makeState({
			sessions: [
				makeSession({ sessionId: "s1", agentName: "gemini", status: "idle" }),
				makeSession({ sessionId: "s2", agentName: "claude", status: "idle" }),
			],
			configuredAgentNames: ["gemini", "claude"],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.sessions[0].status = "active";
		state.sessions[1].status = "active";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("2 sessions: mixed statuses → all same status preserves line count", () => {
		const state = makeState({
			sessions: [
				makeSession({ sessionId: "s1", agentName: "gemini", status: "active" }),
				makeSession({ sessionId: "s2", agentName: "claude", status: "idle" }),
			],
			configuredAgentNames: ["gemini", "claude"],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.sessions[0].status = "active";
		state.sessions[1].status = "active";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("3 sessions: all active → mix of error/active/idle preserves line count", () => {
		const state = makeState({
			sessions: [
				makeSession({ sessionId: "s1", agentName: "agent0", status: "active" }),
				makeSession({ sessionId: "s2", agentName: "agent1", status: "active" }),
				makeSession({ sessionId: "s3", agentName: "agent2", status: "active" }),
			],
			configuredAgentNames: ["agent0", "agent1", "agent2"],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.sessions[0].status = "error";
		state.sessions[1].status = "active";
		state.sessions[2].status = "idle";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});
});

// ── Category C: CB state transitions ────────────────────────────────
// In COMPACT format the circuit-breaker state is rendered INLINE on the
// header line (the " ⚠ CB:open" / " ⚠ CB:half-open" suffix). There is no
// dedicated CB row. Therefore EVERY CB transition (closed↔open,
// open↔half-open, half-open↔closed) preserves the line count — it only
// alters header text. This is the anti-flicker guarantee for CB state.

describe("acp-widget anti-flicker — CB state transitions", () => {
	it("CB closed → open preserves line count (CB state is inline on header)", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "closed",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "open";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("CB open → half-open preserves line count (CB state is inline on header)", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "half-open";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("CB half-open → closed preserves line count (CB state is inline on header)", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "half-open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "closed";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("CB transition + session status change simultaneously preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "active" })],
			circuitBreakerState: "closed",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "open";
		state.sessions[0].status = "error";
		const after = renderWidget(state);
		// CB open is inline (no row); status change only alters row text. Net: 0.
		expect(after.length).toBe(before.length);
		expect(after.length).toBe(expectedLineCount(state));
	});
});

// ── Category D: Activity state ──────────────────────────────────────
// In COMPACT format the activity counters (activeDelegations /
// activeBroadcasts / activeCompares), the lastError hint, the delegations
// array, and the delegationHistory array are NOT rendered as dedicated rows.
// lastError appears inline on the header (when no session is in error state);
// the arrays are not rendered at all. Therefore every activity-state
// transition preserves the line count.

describe("acp-widget anti-flicker — activity state", () => {
	it("Activity delegating → idle preserves line count (inline only)", () => {
		const state = makeState({
			sessions: [makeSession()],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
			},
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		};
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("Activity busy (3 operations) → idle preserves line count (inline only)", () => {
		const state = makeState({
			sessions: [makeSession()],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 1,
				activeCompares: 1,
				delegations: [],
			},
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		};
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("Activity error → no error preserves line count (lastError is inline on header)", () => {
		const state = makeState({
			sessions: [makeSession()],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: "spawn exploded",
			},
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			lastError: undefined,
		};
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("Activity with delegations array → empty preserves line count (not rendered in compact format)", () => {
		const state = makeState({
			sessions: [makeSession()],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [
					{
						id: "d1",
						agentName: "sub-agent",
						phase: "executing",
						startedAt: new Date(),
						lastActivityAt: new Date(),
						text: "working",
					},
				],
			},
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		};
		const after = renderWidget(state);
		// Compact format does not render delegation rows → count unchanged.
		expect(after.length).toBe(before.length);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("Activity with delegation history → empty history preserves line count (not rendered in compact format)", () => {
		const state = makeState({
			sessions: [makeSession()],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				delegationHistory: [
					{
						agentName: "sub-agent",
						status: "completed",
						finishedAt: new Date(),
					},
				],
			},
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			delegationHistory: [],
		};
		const after = renderWidget(state);
		// Compact format does not render a recent-history block → count unchanged.
		expect(after.length).toBe(before.length);
		expect(after.length).toBe(expectedLineCount(state));
	});
});

// ── Category E: Edge cases ──────────────────────────────────────────

describe("acp-widget anti-flicker — edge cases", () => {
	it("Session name change preserves line count (row text only)", () => {
		const state = makeState({
			sessions: [makeSession({ sessionName: "alpha" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.sessions[0].sessionName = "beta";
		const after1 = renderWidget(state);
		expect(after1.length).toBe(before.length);

		state.sessions[0].sessionName = undefined;
		const after2 = renderWidget(state);
		expect(after2.length).toBe(before.length);
	});

	it("0 sessions: CB open → closed preserves line count (CB state is inline)", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: ["gemini"],
			circuitBreakerState: "open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "closed";
		const after = renderWidget(state);
		// Header-only render; CB state is inline → count unchanged.
		expect(after.length).toBe(before.length);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("0 sessions: activity error → idle preserves line count (lastError is inline)", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: ["gemini"],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: "something broke",
			},
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			lastError: undefined,
		};
		const after = renderWidget(state);
		expect(after.length).toBe(before.length);
	});

	it("Header line is present (single header line carrying the ACP marker)", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}`, status: "active" }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		// Compact format emits exactly one header line containing the "ACP"
		// marker (the full-format separator/hints lines no longer exist).
		const headerLines = lines.filter(l => /ACP/.test(l));
		expect(headerLines.length).toBe(1);
	});

	it("No separator/hints lines are emitted in compact format", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}`, status: "active" }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		// Compact format renders header + session rows ONLY (when no dags/workers).
		// There must be no dedicated separator line and no /acp hints line.
		const dashLines = lines.filter(l => /^[-=─]{3,}$/.test(l.trim()));
		expect(dashLines.length).toBe(0);
		const hintLines = lines.filter(l => l.includes("/acp"));
		expect(hintLines.length).toBe(0);
	});
});

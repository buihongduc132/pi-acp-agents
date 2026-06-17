/**
 * Anti-flicker tests for ACP TUI Widget (acp-widget.ts) — R3 invariant
 *
 * These tests verify that the line count produced by render() is deterministic.
 * The widget renders in a FULL format (header + status + session rows +
 * separator + summary + hints), with optional rows for CB-open state, active
 * delegations, recent delegation history, and persistent workers. Line count
 * is a deterministic function of the state — see `expectedLineCount()` below.
 *
 * "Preserves line count" means two states that differ ONLY in text content
 * (not in row-affecting fields) render the same number of lines. Transitions
 * that add/remove rows (CB open↔closed, delegations array, history array,
 * workers) correctly change the count by a computable delta.
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
 * Deterministic line-count model mirroring render() in acp-widget.ts.
 * Full format = header + (CB row if not closed) + status + (active delegation rows)
 * + (recent-history block) + (no-sessions line if empty) + session rows
 * + (workers block) + separator + summary + hints. Hidden when entirely empty.
 */
function expectedLineCount(state: AcpWidgetState): number {
	const hasWorkers = (state.workers?.length ?? 0) > 0;
	if (
		state.sessions.length === 0 &&
		state.configuredAgentNames.length === 0 &&
		!hasWorkers
	) {
		return 0;
	}
	let n = 0;
	n += 1; // header
	n += state.circuitBreakerState !== "closed" ? 1 : 0; // CB row
	n += 1; // status line
	n += state.activity?.delegations?.length ?? 0; // active delegation rows
	const histLen = state.activity?.delegationHistory?.length ?? 0;
	n += histLen > 0 ? 1 + histLen : 0; // recent-history header + rows
	n += state.sessions.length === 0 ? 1 : 0; // no-sessions line
	n += state.sessions.length; // session rows
	const wLen = state.workers?.length ?? 0;
	n += wLen > 0 ? 1 + wLen : 0; // workers header + rows
	n += 1; // separator
	n += 1; // summary
	n += 1; // hints
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

	it("0 sessions + configured agents → full format count", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: ["gemini"],
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
	});

	it("1 session → full format count", () => {
		const state = makeState({
			sessions: [makeSession()],
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
	});

	it("2 sessions → full format count", () => {
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
	});

	it("3 sessions → full format count", () => {
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

	it("4 sessions → full format count", () => {
		const sessions = Array.from({ length: 4 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
	});

	it("5 sessions → full format count (no overflow cap)", () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
	});

	it("10 sessions → full format count (no overflow cap, linear)", () => {
		const sessions = Array.from({ length: 10 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
	});

	it("100 sessions → full format count (linear, every session row renders)", () => {
		const sessions = Array.from({ length: 100 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		expect(lines.length).toBe(expectedLineCount(state));
	});
});

// ── Category B: Status transitions preserve line count ──────────────
// Status (idle/active/error/stale) only changes the session row's icon/text,
// never the row count. So before.length === after.length, and both equal the
// deterministic expectedLineCount(state).

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
// CB "closed" renders NO CB row; CB "open"/"half-open" render a dedicated CB
// row. So:
//   - closed → open:     +1 line (CB row appears)
//   - open → half-open:   0 delta (both render the CB row)
//   - half-open → closed: -1 line (CB row disappears)

describe("acp-widget anti-flicker — CB state transitions", () => {
	it("CB closed → open adds exactly 1 line (CB row appears)", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "closed",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "open";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length + 1);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("CB open → half-open preserves line count (both render CB row)", () => {
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

	it("CB half-open → closed removes exactly 1 line (CB row disappears)", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "half-open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "closed";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length - 1);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("CB transition + session status change simultaneously: +1 line (CB row) + session row text change", () => {
		const state = makeState({
			sessions: [makeSession({ status: "active" })],
			circuitBreakerState: "closed",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "open";
		state.sessions[0].status = "error";
		const after = renderWidget(state);
		// CB open adds 1 row; status change only alters row text. Net: +1.
		expect(after.length).toBe(before.length + 1);
		expect(after.length).toBe(expectedLineCount(state));
	});
});

// ── Category D: Activity state ──────────────────────────────────────
// Activity counters (activeDelegations/activeBroadcasts/activeCompares/lastError)
// only change the status line's text — they do NOT add/remove rows. So those
// transitions preserve line count.
//
// But the `delegations` ARRAY and `delegationHistory` ARRAY each add rows:
//   - delegations array: +1 row per active delegation
//   - delegationHistory array: +1 (recent header) + N (history rows)

describe("acp-widget anti-flicker — activity state", () => {
	it("Activity delegating → idle preserves line count (status-line text only)", () => {
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

	it("Activity busy (3 operations) → idle preserves line count (status-line text only)", () => {
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

	it("Activity error → no error preserves line count (status-line text only)", () => {
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

	it("Activity with delegations array → empty: removes 1 line per delegation row", () => {
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
		// 1 delegation row removed.
		expect(after.length).toBe(before.length - 1);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("Activity with delegation history → empty history: removes recent block (1 header + N rows)", () => {
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
		// Recent block = 1 header + 1 history row = 2 lines removed.
		expect(after.length).toBe(before.length - 2);
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

	it("0 sessions: CB open → closed removes exactly 1 line (CB row)", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: ["gemini"],
			circuitBreakerState: "open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(expectedLineCount(state));

		state.circuitBreakerState = "closed";
		const after = renderWidget(state);
		expect(after.length).toBe(before.length - 1);
		expect(after.length).toBe(expectedLineCount(state));
	});

	it("0 sessions: activity error → idle preserves line count (status-line text only)", () => {
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

	it("Separator line is present (exactly one dedicated dashes line)", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}`, status: "active" }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		// Full format emits one separator line of repeated dashes.
		const dashLines = lines.filter(l => /─{3,}/.test(l));
		expect(dashLines.length).toBe(1);
	});

	it("Hints line is present and advertises /acp commands", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}`, status: "active" }),
		);
		const state = makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		});
		const lines = renderWidget(state);
		// Full format emits a single hints line listing the /acp commands.
		const hintLines = lines.filter(l => l.includes("/acp"));
		expect(hintLines.length).toBe(1);
	});
});

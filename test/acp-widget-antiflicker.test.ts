/**
 * Anti-flicker tests for ACP TUI Widget (acp-widget.ts) — R3 invariant
 *
 * These tests verify that the line count produced by render() is deterministic:
 * same session count always produces the same line count, regardless of
 * session status changes, circuit breaker state transitions, or activity state.
 */
import { describe, expect, it } from "vitest";
import {
	type AcpWidgetDeps,
	type AcpWidgetState,
	type AcpWidgetSession,
	type AcpWidgetActivity,
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

// ── Category A: Static line-count verification ──────────────────────

describe("acp-widget anti-flicker — static line counts", () => {
	it("0 sessions + 0 agents → 0 lines", () => {
		const lines = renderWidget(makeState({
			sessions: [],
			configuredAgentNames: [],
		}));
		expect(lines.length).toBe(0);
	});

	it("0 sessions + configured agents → 1 line", () => {
		const lines = renderWidget(makeState({
			sessions: [],
			configuredAgentNames: ["gemini"],
		}));
		expect(lines.length).toBe(1);
	});

	it("1 session → 2 lines", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
		}));
		expect(lines.length).toBe(2);
	});

	it("2 sessions → 3 lines", () => {
		const sessions = [
			makeSession({ sessionId: "s1", agentName: "gemini" }),
			makeSession({ sessionId: "s2", agentName: "claude" }),
		];
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: ["gemini", "claude"],
		}));
		expect(lines.length).toBe(3);
	});

	it("3 sessions → 4 lines", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		expect(lines.length).toBe(4);
	});

	it("4 sessions → 5 lines", () => {
		const sessions = Array.from({ length: 4 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		expect(lines.length).toBe(5);
	});

	it("5 sessions → 5 lines (overflow)", () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		expect(lines.length).toBe(5);
	});

	it("10 sessions → 5 lines (overflow)", () => {
		const sessions = Array.from({ length: 10 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		expect(lines.length).toBe(5);
	});

	it("100 sessions → 5 lines (overflow)", () => {
		const sessions = Array.from({ length: 100 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		expect(lines.length).toBe(5);
	});
});

// ── Category B: Status transitions preserve line count ──────────────

describe("acp-widget anti-flicker — status transitions", () => {
	it("1 session: idle → active preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "idle" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.sessions[0].status = "active";
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("1 session: active → error preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "active" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.sessions[0].status = "error";
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("1 session: active → stale preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "active" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.sessions[0].status = "stale";
		const after = renderWidget(state);
		expect(after.length).toBe(2);
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
		expect(before.length).toBe(3);

		state.sessions[0].status = "active";
		state.sessions[1].status = "active";
		const after = renderWidget(state);
		expect(after.length).toBe(3);
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
		expect(before.length).toBe(3);

		state.sessions[0].status = "active";
		state.sessions[1].status = "active";
		const after = renderWidget(state);
		expect(after.length).toBe(3);
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
		expect(before.length).toBe(4);

		state.sessions[0].status = "error";
		state.sessions[1].status = "active";
		state.sessions[2].status = "idle";
		const after = renderWidget(state);
		expect(after.length).toBe(4);
	});
});

// ── Category C: CB state transitions preserve line count ────────────

describe("acp-widget anti-flicker — CB state transitions", () => {
	it("CB closed → open preserves line count", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "closed",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.circuitBreakerState = "open";
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("CB open → half-open preserves line count", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.circuitBreakerState = "half-open";
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("CB half-open → closed preserves line count", () => {
		const state = makeState({
			sessions: [makeSession()],
			circuitBreakerState: "half-open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.circuitBreakerState = "closed";
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("CB transition + session status change simultaneously preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ status: "active" })],
			circuitBreakerState: "closed",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.circuitBreakerState = "open";
		state.sessions[0].status = "error";
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});
});

// ── Category D: Activity state does NOT affect line count ───────────

describe("acp-widget anti-flicker — activity state", () => {
	it("Activity delegating → idle preserves line count", () => {
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
		expect(before.length).toBe(2);

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		};
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("Activity busy (3 operations) → idle preserves line count", () => {
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
		expect(before.length).toBe(2);

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		};
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("Activity error → no error preserves line count", () => {
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
		expect(before.length).toBe(2);

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			lastError: undefined,
		};
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("Activity with delegations array → empty delegations preserves line count", () => {
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
		expect(before.length).toBe(2);

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		};
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});

	it("Activity with delegation history → empty history preserves line count", () => {
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
		expect(before.length).toBe(2);

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			delegationHistory: [],
		};
		const after = renderWidget(state);
		expect(after.length).toBe(2);
	});
});

// ── Category E: Edge cases ──────────────────────────────────────────

describe("acp-widget anti-flicker — edge cases", () => {
	it("Session name change preserves line count", () => {
		const state = makeState({
			sessions: [makeSession({ sessionName: "alpha" })],
		});
		const before = renderWidget(state);
		expect(before.length).toBe(2);

		state.sessions[0].sessionName = "beta";
		const after1 = renderWidget(state);
		expect(after1.length).toBe(2);

		state.sessions[0].sessionName = undefined;
		const after2 = renderWidget(state);
		expect(after2.length).toBe(2);
	});

	it("0 sessions: CB open → closed preserves line count", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: ["gemini"],
			circuitBreakerState: "open",
		});
		const before = renderWidget(state);
		expect(before.length).toBe(1);

		state.circuitBreakerState = "closed";
		const after = renderWidget(state);
		expect(after.length).toBe(1);
	});

	it("0 sessions: activity error → idle preserves line count", () => {
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
		expect(before.length).toBe(1);

		state.activity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			lastError: undefined,
		};
		const after = renderWidget(state);
		expect(after.length).toBe(1);
	});

	it("No line contains repeated dashes (separator artifact)", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}`, status: "active" }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		for (const line of lines) {
			expect(line).not.toMatch(/─{3,}/);
		}
	});

	it("No line contains /acp hints", () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}`, status: "active" }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		for (const line of lines) {
			expect(line).not.toContain("/acp");
		}
	});
});

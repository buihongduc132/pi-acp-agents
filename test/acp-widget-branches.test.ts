/**
 * Branch coverage for acp-widget.ts — full format
 */
import { describe, it, expect } from "vitest";
import { createAcpWidget, type AcpWidgetState, type AcpWidgetSession, type AcpWidgetDeps, type AcpWidgetDag } from "../src/acp-widget.js";

const mockTheme: any = {
	bold: (s: string) => `<b>${s}</>`,
	fg: (color: string, s: string) => `<${color}>${s}</>`,
};

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
		// Explicit `dags` default: undefined preserves pre-change rendering for
		// every existing fixture; tests may override via `makeState({ dags })`.
		dags: undefined,
		...overrides,
	};
}

function renderWidget(state: AcpWidgetState): string[] {
	const deps: AcpWidgetDeps = { getState: () => state };
	const factory = createAcpWidget(deps);
	const widget = factory({}, mockTheme);
	return widget.render(120);
}

/**
 * Deterministic full-format line count (CB closed, no delegations/history/workers):
 *  - 0 sessions + configured agents → 6
 *  - N sessions (N ≥ 1) → N + 5
 */
function expectedLineCount(sessions: AcpWidgetSession[]): number {
	return sessions.length === 0 ? 6 : sessions.length + 5;
}

describe("acp-widget — branch coverage", () => {
	it("timeAgo: 'just now' (<5s)", () => {
		const sessions = [makeSession({ lastActivityAt: new Date() })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("just now");
	});

	it("timeAgo: seconds ago", () => {
		const sessions = [makeSession({ lastActivityAt: new Date(Date.now() - 10_000) })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("s ago");
	});

	it("timeAgo: minutes ago", () => {
		const sessions = [makeSession({ lastActivityAt: new Date(Date.now() - 120_000) })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("m ago");
	});

	it("timeAgo: hours ago", () => {
		const sessions = [makeSession({ lastActivityAt: new Date(Date.now() - 7_200_000) })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("h ago");
	});

	it("timeAgo: days ago", () => {
		const sessions = [makeSession({ lastActivityAt: new Date(Date.now() - 172_800_000) })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("d ago");
	});

	it("circuit breaker half-open state — rendered on its own line", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({ sessions, circuitBreakerState: "half-open" }));
		const joined = lines.join("\n");
		expect(joined).toContain("half-open (probing)");
		expect(joined).toContain("circuit breaker");
	});

	it("circuit breaker open state — rendered on its own line", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({ sessions, circuitBreakerState: "open" }));
		const joined = lines.join("\n");
		expect(joined).toContain("circuit breaker: open");
	});

	it("activity: broadcasting — status line shows broadcasting", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({
			sessions,
			activity: { activeDelegations: 0, activeBroadcasts: 1, activeCompares: 0, delegations: [] },
		}));
		const joined = lines.join("\n");
		expect(lines.length).toBe(expectedLineCount(sessions));
		expect(joined).toContain("gemini");
		expect(joined).toContain("broadcasting");
	});

	it("activity: comparing — status line shows comparing", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({
			sessions,
			activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 1, delegations: [] },
		}));
		const joined = lines.join("\n");
		expect(lines.length).toBe(expectedLineCount(sessions));
		expect(joined).toContain("gemini");
		expect(joined).toContain("comparing");
	});

	it("activity: delegating — status line shows delegating", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({
			sessions,
			activity: { activeDelegations: 1, activeBroadcasts: 0, activeCompares: 0, delegations: [] },
		}));
		const joined = lines.join("\n");
		expect(lines.length).toBe(expectedLineCount(sessions));
		expect(joined).toContain("gemini");
		expect(joined).toContain("delegating");
	});

	it("activity: busy (multiple) — status line shows busy", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({
			sessions,
			activity: { activeDelegations: 2, activeBroadcasts: 1, activeCompares: 0, delegations: [] },
		}));
		const joined = lines.join("\n");
		expect(lines.length).toBe(expectedLineCount(sessions));
		expect(joined).toContain("gemini");
		expect(joined).toContain("busy");
	});

	it("activity: error state — status line shows activity error", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({
			sessions,
			activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, lastError: "timeout", delegations: [] },
		}));
		const joined = lines.join("\n");
		expect(lines.length).toBe(expectedLineCount(sessions));
		expect(joined).toContain("gemini");
		expect(joined).toContain("error: timeout");
	});

	it("session with model — full format renders model in session row", () => {
		const sessions = [makeSession({ model: "gemini-2.5-pro" })];
		const lines = renderWidget(makeState({ sessions }));
		const joined = lines.join("\n");
		expect(joined).toContain("gemini-2.5-pro");
	});

	it("session with sessionName", () => {
		const sessions = [makeSession({ sessionName: "my-session" })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("my-session");
	});

	it("idle session status", () => {
		const sessions = [makeSession({ status: "idle" })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("idle");
	});

	it("stale session status", () => {
		const sessions = [makeSession({ status: "stale" })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("stale");
	});

	it("error session status", () => {
		const sessions = [makeSession({ status: "error" })];
		const lines = renderWidget(makeState({ sessions }));
		expect(lines.join("\n")).toContain("error");
	});

	it("default agent label — summary line shows default", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({ sessions, defaultAgent: "gemini" }));
		const joined = lines.join("\n");
		expect(joined).toContain("default: gemini");
	});

	it("dispose clears interval", () => {
		const deps: AcpWidgetDeps = { getState: () => makeState({ sessions: [makeSession()] }) };
		const factory = createAcpWidget(deps);
		const widget = factory({}, mockTheme);
		expect(() => widget.dispose?.()).not.toThrow();
	});

	it("invalidate does not throw", () => {
		const deps: AcpWidgetDeps = { getState: () => makeState({ sessions: [makeSession()] }) };
		const factory = createAcpWidget(deps);
		const widget = factory({}, mockTheme);
		expect(() => widget.invalidate()).not.toThrow();
	});

	// ── New branch-coverage tests ──

	it("0 sessions + configured agents → full format panel (6 lines)", () => {
		const sessions: AcpWidgetSession[] = [];
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: ["gemini", "claude"],
		}));
		expect(lines.length).toBe(expectedLineCount(sessions));
	});

	it("0 sessions + 0 configured agents → empty array", () => {
		const lines = renderWidget(makeState({
			sessions: [],
			configuredAgentNames: [],
		}));
		expect(lines).toEqual([]);
	});

	it("no overflow cap: 5 sessions render fully — last session appears in output", () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map((s) => s.agentName),
		}));
		// Line count is a deterministic function of session count (no cap).
		expect(lines.length).toBe(expectedLineCount(sessions));
		// The last session is rendered (no "+N more" overflow).
		expect(lines.join("\n")).toContain("agent4");
		expect(lines.join("\n")).not.toContain("more");
	});

	it("CB on its own line: closed does not render circuit breaker text", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({ sessions, circuitBreakerState: "closed" }));
		expect(lines.join("\n")).not.toContain("circuit breaker");
	});

	it("CB on its own line: open renders circuit breaker: open", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({ sessions, circuitBreakerState: "open" }));
		expect(lines.join("\n")).toContain("circuit breaker: open");
	});

	it("CB on its own line: half-open renders circuit breaker: half-open", () => {
		const sessions = [makeSession()];
		const lines = renderWidget(makeState({ sessions, circuitBreakerState: "half-open" }));
		expect(lines.join("\n")).toContain("circuit breaker: half-open");
	});

	// ── Anti-flicker branch-coverage tests ──

	it("CB open vs closed — open adds exactly +1 line (dedicated CB row)", () => {
		const sessions = [makeSession()];
		const linesOpen = renderWidget(makeState({ sessions, circuitBreakerState: "open" }));
		const linesClosed = renderWidget(makeState({ sessions, circuitBreakerState: "closed" }));
		expect(linesClosed.length).toBe(expectedLineCount(sessions));
		// open emits one extra dedicated circuit-breaker line vs closed
		expect(linesOpen.length).toBe(linesClosed.length + 1);
	});

	it("CB half-open vs closed — half-open adds exactly +1 line (dedicated CB row)", () => {
		const sessions = [makeSession()];
		const linesHalfOpen = renderWidget(makeState({ sessions, circuitBreakerState: "half-open" }));
		const linesClosed = renderWidget(makeState({ sessions, circuitBreakerState: "closed" }));
		expect(linesClosed.length).toBe(expectedLineCount(sessions));
		expect(linesHalfOpen.length).toBe(linesClosed.length + 1);
	});

	it("no overflow cap: 5 sessions — line count is linear, every session rendered", () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map((s) => s.agentName),
		}));
		expect(lines.length).toBe(expectedLineCount(sessions));
		expect(lines.join("\n")).toContain("agent4");
		expect(lines.join("\n")).not.toContain("more");
	});

	it("no overflow cap: 10 sessions — line count is linear, every session rendered", () => {
		const sessions = Array.from({ length: 10 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map((s) => s.agentName),
		}));
		expect(lines.length).toBe(expectedLineCount(sessions));
		expect(lines.join("\n")).toContain("agent9");
		expect(lines.join("\n")).not.toContain("more");
	});

	it("fixed-width name padding: different name lengths produce same line count", () => {
		const sessionsA = [
			makeSession({ sessionId: "s1", agentName: "gpt" }),
			makeSession({ sessionId: "s2", agentName: "very-long-agent-name" }),
		];
		const sessionsB = [
			makeSession({ sessionId: "s1", agentName: "gemini" }),
			makeSession({ sessionId: "s2", agentName: "claude" }),
		];
		const linesA = renderWidget(makeState({
			sessions: sessionsA,
			configuredAgentNames: ["gpt", "very-long-agent-name"],
		}));
		const linesB = renderWidget(makeState({
			sessions: sessionsB,
			configuredAgentNames: ["gemini", "claude"],
		}));
		expect(linesA.length).toBe(expectedLineCount(sessionsA));
		expect(linesB.length).toBe(expectedLineCount(sessionsB));
		expect(linesA.length).toBe(linesB.length);
	});
});

describe("makeState fixture — no dags field regression guard", () => {
	it("no dags field → renders identically to pre-change (no DAG section)", () => {
		const sessions = [makeSession()];
		const state = makeState({ sessions });
		// Regression guard: `dags` is undefined, so the widget MUST NOT render
		// any DAG-related section (no header, no rows, no summary).
		expect(state.dags).toBeUndefined();
		const lines = renderWidget(state);
		const joined = lines.join("\n");
		expect(joined).not.toContain("DAGs");
		expect(joined).not.toContain("DAG");
		// Line count must match the pre-change deterministic expected count.
		expect(lines.length).toBe(expectedLineCount(sessions));
	});
});

describe("makeState fixture — dags override", () => {
	it("defaults dags to undefined when no override given (preserves existing fixtures)", () => {
		const state = makeState();
		expect(state.dags).toBeUndefined();
	});

	it("accepts a dags override and surfaces it on the returned state", () => {
		const dags: AcpWidgetDag[] = [
			{
				dagId: "abc",
				status: "running",
				total: 5,
				completed: 2,
				failed: 1,
				cancelled: 0,
				currentWave: 2,
				totalWaves: 3,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];
		const state = makeState({ dags });
		expect(state.dags).toBe(dags);
		expect(state.dags?.length).toBe(1);
	});
});

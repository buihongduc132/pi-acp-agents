/**
 * Branch coverage for acp-widget.ts — compact format
 */
import { describe, it, expect } from "vitest";
import { createAcpWidget, type AcpWidgetState, type AcpWidgetSession, type AcpWidgetDeps } from "../src/acp-widget.js";

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
		...overrides,
	};
}

function renderWidget(state: AcpWidgetState): string[] {
	const deps: AcpWidgetDeps = { getState: () => state };
	const factory = createAcpWidget(deps);
	const widget = factory({}, mockTheme);
	return widget.render(120);
}

describe("acp-widget — branch coverage", () => {
	it("timeAgo: 'just now' (<5s)", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ lastActivityAt: new Date() })],
		}));
		expect(lines.join("\n")).toContain("just now");
	});

	it("timeAgo: seconds ago", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ lastActivityAt: new Date(Date.now() - 10_000) })],
		}));
		expect(lines.join("\n")).toContain("s ago");
	});

	it("timeAgo: minutes ago", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ lastActivityAt: new Date(Date.now() - 120_000) })],
		}));
		expect(lines.join("\n")).toContain("m ago");
	});

	it("timeAgo: hours ago", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ lastActivityAt: new Date(Date.now() - 7_200_000) })],
		}));
		expect(lines.join("\n")).toContain("h ago");
	});

	it("timeAgo: days ago", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ lastActivityAt: new Date(Date.now() - 172_800_000) })],
		}));
		expect(lines.join("\n")).toContain("d ago");
	});

	it("circuit breaker half-open state", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "half-open",
		}));
		expect(lines.join("\n")).toContain("half-open");
		expect(lines[0]).toContain("CB:half-open");
	});

	it("circuit breaker open state", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "open",
		}));
		expect(lines.join("\n")).toContain("CB:open");
	});

	it("activity: broadcasting — compact format does not show activity status", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 0, activeBroadcasts: 1, activeCompares: 0, delegations: [] },
		}));
		expect(lines.length).toBe(2); // header + session row
		expect(lines.join("\n")).toContain("gemini");
		expect(lines.join("\n")).not.toContain("broadcasting");
	});

	it("activity: comparing — compact format does not show activity status", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 1, delegations: [] },
		}));
		expect(lines.length).toBe(2);
		expect(lines.join("\n")).toContain("gemini");
		expect(lines.join("\n")).not.toContain("comparing");
	});

	it("activity: delegating — compact format does not show activity status", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 1, activeBroadcasts: 0, activeCompares: 0, delegations: [] },
		}));
		expect(lines.length).toBe(2);
		expect(lines.join("\n")).toContain("gemini");
		expect(lines.join("\n")).not.toContain("delegating");
	});

	it("activity: busy (multiple) — compact format does not show activity status", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 2, activeBroadcasts: 1, activeCompares: 0, delegations: [] },
		}));
		expect(lines.length).toBe(2);
		expect(lines.join("\n")).toContain("gemini");
		expect(lines.join("\n")).not.toContain("busy");
	});

	it("activity: error state — compact format does not show activity error", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, lastError: "timeout", delegations: [] },
		}));
		expect(lines.length).toBe(2);
		expect(lines.join("\n")).toContain("gemini");
		expect(lines.join("\n")).not.toContain("error: timeout");
	});

	it("session with model — compact format does not show model", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ model: "gemini-2.5-pro" })],
		}));
		expect(lines.join("\n")).not.toContain("gemini-2.5-pro");
	});

	it("session with sessionName", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ sessionName: "my-session" })],
		}));
		expect(lines.join("\n")).toContain("my-session");
	});

	it("idle session status", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ status: "idle" })],
		}));
		expect(lines.join("\n")).toContain("idle");
	});

	it("stale session status", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ status: "stale" })],
		}));
		expect(lines.join("\n")).toContain("stale");
	});

	it("error session status", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ status: "error" })],
		}));
		expect(lines.join("\n")).toContain("error");
	});

	it("default agent label — compact format does not show default", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			defaultAgent: "gemini",
		}));
		expect(lines.join("\n")).not.toContain("default: gemini");
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

	it("0 sessions + configured agents → 1 line header only", () => {
		const lines = renderWidget(makeState({
			sessions: [],
			configuredAgentNames: ["gemini", "claude"],
		}));
		expect(lines.length).toBe(1);
	});

	it("0 sessions + 0 configured agents → empty array", () => {
		const lines = renderWidget(makeState({
			sessions: [],
			configuredAgentNames: [],
		}));
		expect(lines).toEqual([]);
	});

	it("overflow: 5 sessions → last row contains +1 more", () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map(s => s.agentName),
		}));
		expect(lines.length).toBe(5);
		expect(lines[lines.length - 1]).toContain("+1 more");
	});

	it("CB inline on header: closed does not add CB text", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "closed",
		}));
		expect(lines[0]).not.toContain("CB:");
	});

	it("CB inline on header: open adds CB:open", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "open",
		}));
		expect(lines[0]).toContain("CB:open");
	});

	it("CB inline on header: half-open adds CB:half-open", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "half-open",
		}));
		expect(lines[0]).toContain("CB:half-open");
	});

	// ── Anti-flicker branch-coverage tests ──

	it("CB open inline on header — line count unchanged", () => {
		const linesOpen = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "open",
		}));
		const linesClosed = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "closed",
		}));
		expect(linesOpen.length).toBe(2); // header + 1 session row
		expect(linesClosed.length).toBe(2);
		expect(linesOpen.length).toBe(linesClosed.length);
	});

	it("CB half-open inline on header — line count unchanged", () => {
		const linesHalfOpen = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "half-open",
		}));
		const linesClosed = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "closed",
		}));
		expect(linesHalfOpen.length).toBe(2);
		expect(linesClosed.length).toBe(2);
		expect(linesHalfOpen.length).toBe(linesClosed.length);
	});

	it("overflow branch: exactly 4 rows + inline overflow for 5 sessions", () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map((s) => s.agentName),
		}));
		expect(lines.length).toBe(5); // 1 header + 4 rows
		expect(lines[lines.length - 1]).toContain("+1 more");
	});

	it("overflow branch: exactly 4 rows + inline overflow for 10 sessions", () => {
		const sessions = Array.from({ length: 10 }, (_, i) =>
			makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
		);
		const lines = renderWidget(makeState({
			sessions,
			configuredAgentNames: sessions.map((s) => s.agentName),
		}));
		expect(lines.length).toBe(5); // 1 header + 4 rows
		expect(lines[lines.length - 1]).toContain("+6 more");
	});

	it("fixed-width name padding: different name lengths produce same line count", () => {
		const stateA = makeState({
			sessions: [
				makeSession({ sessionId: "s1", agentName: "gpt" }),
				makeSession({ sessionId: "s2", agentName: "very-long-agent-name" }),
			],
			configuredAgentNames: ["gpt", "very-long-agent-name"],
		});
		const stateB = makeState({
			sessions: [
				makeSession({ sessionId: "s1", agentName: "gemini" }),
				makeSession({ sessionId: "s2", agentName: "claude" }),
			],
			configuredAgentNames: ["gemini", "claude"],
		});
		const linesA = renderWidget(stateA);
		const linesB = renderWidget(stateB);
		expect(linesA.length).toBe(3); // header + 2 rows
		expect(linesB.length).toBe(3);
		expect(linesA.length).toBe(linesB.length);
	});
});

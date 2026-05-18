/**
 * Branch coverage for acp-widget.ts — formatTokens and timeAgo branches
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
	});

	it("circuit breaker open state", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			circuitBreakerState: "open",
		}));
		expect(lines.join("\n")).toContain("circuit breaker");
	});

	it("activity: broadcasting", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 0, activeBroadcasts: 1, activeCompares: 0 },
		}));
		expect(lines.join("\n")).toContain("broadcasting");
	});

	it("activity: comparing", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 1 },
		}));
		expect(lines.join("\n")).toContain("comparing");
	});

	it("activity: delegating", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 1, activeBroadcasts: 0, activeCompares: 0 },
		}));
		expect(lines.join("\n")).toContain("delegating");
	});

	it("activity: busy (multiple)", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 2, activeBroadcasts: 1, activeCompares: 0 },
		}));
		expect(lines.join("\n")).toContain("busy (3)");
	});

	it("activity: error state", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, lastError: "timeout" },
		}));
		expect(lines.join("\n")).toContain("error: timeout");
	});

	it("session with model", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession({ model: "gemini-2.5-pro" })],
		}));
		expect(lines.join("\n")).toContain("gemini-2.5-pro");
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

	it("default agent label", () => {
		const lines = renderWidget(makeState({
			sessions: [makeSession()],
			defaultAgent: "gemini",
		}));
		expect(lines.join("\n")).toContain("default: gemini");
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
});

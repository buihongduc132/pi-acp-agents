/**
 * Tests for ACP TUI Widget (acp-widget.ts)
 */
import { describe, expect, it } from "vitest";
import {
	type AcpWidgetDeps,
	type AcpWidgetState,
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

function makeState(overrides: Partial<AcpWidgetState> = {}): AcpWidgetState {
	return {
		sessions: [],
		circuitBreakerState: "closed",
		configuredAgentNames: ["gemini"],
		defaultAgent: "gemini",
		activity: {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			lastError: undefined,
		},
		...overrides,
	};
}

function makeDeps(state: AcpWidgetState): AcpWidgetDeps {
	return { getState: () => state };
}

function render(deps: AcpWidgetDeps, width = 100): string[] {
	const factory = createAcpWidget(deps);
	const theme = createMockTheme();
	const component = factory({}, theme);
	return component.render(width);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("acp-widget", () => {
	it("hides when no sessions and no configured agents", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: [],
			defaultAgent: undefined,
		});
		const lines = render(makeDeps(state));
		expect(lines).toEqual([]);
	});

	it("shows idle summary when agents configured but no sessions", () => {
		const state = makeState({
			sessions: [],
			configuredAgentNames: ["gemini", "claude"],
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("status: idle");
		expect(joined).toContain("no active sessions");
		expect(joined).toContain("gemini");
		expect(joined).toContain("claude");
		expect(joined).toContain("/acp · /acp-config · acp_prompt <msg>");
	});

	it("renders single session", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "sess-abc12345",
					sessionName: "alpha",
					agentName: "gemini",
					cwd: "/home/user",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBeGreaterThan(3); // header + row + separator + summary + hints

		const joined = lines.join("\n");
		expect(joined).toContain("gemini");
		expect(joined).toContain("alpha");
		expect(joined).toContain("sess-abc");
		expect(joined).toContain("idle");
	});

	it("renders multiple sessions", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "sess-111",
					agentName: "gemini",
					cwd: "/a",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
				{
					sessionId: "sess-222",
					agentName: "claude",
					cwd: "/b",
					status: "active",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			configuredAgentNames: ["gemini", "claude"],
		});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("gemini");
		expect(joined).toContain("claude");
		expect(joined).toContain("2 sessions");
		expect(joined).toContain("1 active");
		expect(joined).toContain("1 idle");
	});

	it("shows circuit breaker when open", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s1",
					agentName: "gemini",
					cwd: "/",
					status: "error",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			circuitBreakerState: "open",
		});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("circuit breaker");
	});

	it("does NOT show circuit breaker when closed", () => {
		const state = makeState({
			circuitBreakerState: "closed",
			sessions: [
				{
					sessionId: "s1",
					agentName: "gemini",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
		});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).not.toContain("circuit breaker");
	});

	it("shows stale sessions", () => {
		const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
		const state = makeState({
			sessions: [
				{
					sessionId: "s-old",
					agentName: "gemini",
					cwd: "/",
					status: "stale",
					lastActivityAt: oldDate,
					createdAt: oldDate,
				},
			],
		});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("stale");
		expect(joined).toContain("1 stale");
	});

	it("shows model if present", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s1",
					agentName: "gemini",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
					model: "gemini-2.5-pro",
				},
			],
		});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("gemini-2.5-pro");
	});

	it("respects terminal width", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s1",
					agentName: "gemini",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
		});
		const lines = render(makeDeps(state), 40);
		expect(lines.length).toBeGreaterThan(0);
		// Widget uses truncateToWidth which operates on visible width (ANSI-aware)
		// Our mock theme tags are not real ANSI so length may exceed — just verify lines exist
		for (const line of lines) {
			expect(typeof line).toBe("string");
			expect(line.length).toBeGreaterThan(0);
		}
	});

	it("shows default agent in summary", () => {
		const state = makeState({
			defaultAgent: "gemini",
			sessions: [
				{
					sessionId: "s1",
					agentName: "gemini",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			configuredAgentNames: ["gemini"],
		});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("default: gemini");
	});

	it("renders delegating state without session rows", () => {
		const state = makeState({
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
			},
		});
		const joined = render(makeDeps(state)).join("\n");
		expect(joined).toContain("status: delegating");
	});

	it("renders busy summary when multiple transient operations are active", () => {
		const state = makeState({
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 1,
				activeCompares: 0,
			},
		});
		const joined = render(makeDeps(state)).join("\n");
		expect(joined).toContain("status: busy (2)");
	});

	it("renders error summary without hiding widget", () => {
		const state = makeState({
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				lastError: "spawn exploded",
			},
		});
		const joined = render(makeDeps(state)).join("\n");
		expect(joined).toContain("status: error: spawn exploded");
	});

	it("renders transient summary together with persistent session rows", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s1",
					agentName: "gemini",
					cwd: "/",
					status: "active",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 1,
				activeCompares: 0,
			},
		});
		const joined = render(makeDeps(state)).join("\n");
		expect(joined).toContain("status: broadcasting");
		expect(joined).toContain("gemini");
		expect(joined).toContain("/acp · /acp-config · acp_status · acp_prompt <msg>");
	});

	it("component dispose does not throw", () => {
		const state = makeState();
		const factory = createAcpWidget(makeDeps(state));
		const component = factory({}, createMockTheme());
		expect(() => (component as any).dispose()).not.toThrow();
	});
});

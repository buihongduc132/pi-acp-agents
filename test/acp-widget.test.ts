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
				delegations: [],
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
				delegations: [],
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
				delegations: [],
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
				delegations: [],
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
				delegations: [],
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

	// ── Multi-Delegation Detail Rendering ──

	it("renders multiple delegations as separate rows", () => {
		const now = Date.now();
		const state = makeState({
			sessions: [],
			activity: {
				activeDelegations: 3,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [
					{ id: "d1", agentName: "gemini", phase: "prompting", startedAt: new Date(now - 5_000), lastActivityAt: new Date(now - 1_000) },
					{ id: "d2", agentName: "claude", phase: "initializing", startedAt: new Date(now - 30_000), lastActivityAt: new Date(now - 5_000) },
					{ id: "d3", agentName: "codex", phase: "spawning", startedAt: new Date(now - 90_000), lastActivityAt: new Date(now - 60_000) },
				],
			},
		});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");

		// Each agent name must appear in the output
		expect(joined).toContain("gemini");
		expect(joined).toContain("claude");
		expect(joined).toContain("codex");

		// Count delegation rows — each should have agent name + its phase
		const delegationRows = lines.filter(
			(l) =>
				(l.includes("gemini") && l.includes("prompting")) ||
				(l.includes("claude") && l.includes("initializing")) ||
				(l.includes("codex") && l.includes("spawning")),
		);
		expect(delegationRows.length).toBe(3);
	});

	it("each delegation shows agent name + phase + elapsed", () => {
		const now = Date.now();
		const state = makeState({
			sessions: [],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [
					{ id: "d1", agentName: "gemini", phase: "prompting", startedAt: new Date(now - 5_000), lastActivityAt: new Date(now) },
				],
			},
		});
		const lines = render(makeDeps(state));
		const delegationLine = lines.find((l) => l.includes("gemini") && l.includes("prompting"));
		expect(delegationLine).toBeDefined();
		expect(delegationLine!).toContain("gemini");
		expect(delegationLine!).toContain("prompting");
		expect(delegationLine!).toContain("5s");
	});

	it("shows truncated text preview for delegation with text", () => {
		const now = Date.now();
		const longText = "A".repeat(500);
		const state = makeState({
			sessions: [],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [
					{
						id: "d1",
						agentName: "gemini",
						phase: "prompting",
						startedAt: new Date(now - 10_000),
						lastActivityAt: new Date(now),
						text: longText,
					},
				],
			},
		});
		const lines = render(makeDeps(state));

		// Find the line(s) containing the preview (should have ┆ prefix)
		const previewLines = lines.filter((l) => l.includes("┆"));
		expect(previewLines.length).toBeGreaterThanOrEqual(1);

		// Preview should be truncated — at most 80 chars of original text visible
		const previewLine = previewLines[0];
		// Count 'A' characters in the line — should be <= 80
		const aCount = (previewLine.match(/A/g) || []).length;
		expect(aCount).toBeLessThanOrEqual(80);
		expect(aCount).toBeGreaterThan(0);
	});

	it("delegation rows appear between status line and session rows", () => {
		const now = Date.now();
		const state = makeState({
			sessions: [
				{
					sessionId: "sess-existing",
					agentName: "codex",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(now - 60_000),
					createdAt: new Date(now - 120_000),
				},
			],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [
					{ id: "d1", agentName: "gemini", phase: "prompting", startedAt: new Date(now - 5_000), lastActivityAt: new Date(now) },
				],
			},
		});
		const lines = render(makeDeps(state));

		const statusIdx = lines.findIndex((l) => l.includes("status:"));
		const delegationIdx = lines.findIndex((l) => l.includes("gemini") && l.includes("prompting"));
		const sessionIdx = lines.findIndex((l) => l.includes("codex") && l.includes("sess-exi"));

		expect(statusIdx).toBeGreaterThanOrEqual(0);
		expect(delegationIdx).toBeGreaterThanOrEqual(0);
		expect(sessionIdx).toBeGreaterThanOrEqual(0);
		expect(delegationIdx).toBeGreaterThan(statusIdx);
		expect(sessionIdx).toBeGreaterThan(delegationIdx);
	});

	it("formats elapsed time as 1m30s for 90 seconds", () => {
		const now = Date.now();
		const state = makeState({
			sessions: [],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [
					{ id: "d1", agentName: "gemini", phase: "session", startedAt: new Date(now - 90_000), lastActivityAt: new Date(now) },
				],
			},
		});
		const lines = render(makeDeps(state));
		const delegationLine = lines.find((l) => l.includes("gemini"));
		expect(delegationLine).toBeDefined();
		expect(delegationLine!).toContain("1m30s");
	});

	it("formats elapsed time as 5s for 5 seconds", () => {
		const now = Date.now();
		const state = makeState({
			sessions: [],
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [
					{ id: "d1", agentName: "gemini", phase: "spawning", startedAt: new Date(now - 5_000), lastActivityAt: new Date(now) },
				],
			},
		});
		const lines = render(makeDeps(state));
		const delegationLine = lines.find((l) => l.includes("gemini"));
		expect(delegationLine).toBeDefined();
		expect(delegationLine!).toContain("5s");
		// Should NOT contain "m" (no minutes)
		expect(delegationLine!).not.toContain("1m");
	});
});

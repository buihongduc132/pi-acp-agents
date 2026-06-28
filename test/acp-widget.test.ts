/**
 * Tests for ACP TUI Widget (acp-widget.ts) — compact format
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
		expect(lines.length).toBe(1);
		const joined = lines.join("\n");
		expect(joined).toContain("ACP");
		expect(joined).toContain("idle");
		expect(joined).not.toContain("status: idle");
		expect(joined).not.toContain("no active sessions");
		expect(joined).not.toContain("/acp · /acp-config · acp_prompt <msg>");
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
		expect(lines.length).toBe(2);

		const joined = lines.join("\n");
		expect(joined).toContain("gemini");
		expect(joined).toContain("alpha");
		expect(joined).toContain("sess-abc");
		// No separator line
		expect(joined).not.toContain("───");
		// No hints line
		expect(joined).not.toContain("/acp");
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
		// No standalone "2 sessions" summary line
		expect(joined).not.toContain("2 sessions");
		// No separate "1 active" / "1 idle" on summary line
		expect(lines.length).toBe(3); // header + 2 rows
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
		// CB text appears inline on header (line 0)
		expect(lines[0]).toContain("CB:open");
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
		expect(joined).not.toContain("CB:");
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
	});

	it("shows model if present — compact format drops model", () => {
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
		// Compact format intentionally does NOT show model
		expect(joined).not.toContain("gemini-2.5-pro");
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
		expect(lines.length).toBe(2);
		for (const line of lines) {
			expect(typeof line).toBe("string");
			expect(line.length).toBeGreaterThan(0);
		}
	});

	it("shows default agent in summary — compact format drops default", () => {
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
		// Compact format intentionally does NOT show "default: X"
		expect(joined).not.toContain("default:");
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
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(1); // header only
		const joined = lines.join("\n");
		expect(joined).toContain("ACP");
		expect(joined).toContain("idle");
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
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(1); // header only
		const joined = lines.join("\n");
		expect(joined).toContain("ACP");
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
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(1);
		const joined = lines.join("\n");
		expect(joined).toContain("spawn exploded");
		expect(lines[0]).toContain("⚠");
		expect(joined).toContain("ACP");
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
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(2); // header + 1 session row
		const joined = lines.join("\n");
		// Activity status is no longer shown
		expect(joined).not.toContain("broadcasting");
		expect(joined).toContain("gemini");
		expect(joined).not.toContain("/acp");
	});

	it("component dispose does not throw", () => {
		const state = makeState();
		const factory = createAcpWidget(makeDeps(state));
		const component = factory({}, createMockTheme());
		expect(() => (component as any).dispose()).not.toThrow();
	});

	// ── New compact-format tests ──

	it("3 sessions produce exactly 4 lines", () => {
		const sessions = Array.from({ length: 3 }, (_, i) => ({
			sessionId: `s${i}`,
			agentName: `agent${i}`,
			cwd: "/",
			status: "active" as const,
			lastActivityAt: new Date(),
			createdAt: new Date(),
		}));
		const state = makeState({ sessions, configuredAgentNames: ["agent0", "agent1", "agent2"] });
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(4); // header + 3 rows
	});

	it("5 sessions produce exactly 5 lines with overflow", () => {
		const sessions = Array.from({ length: 5 }, (_, i) => ({
			sessionId: `s${i}`,
			agentName: `agent${i}`,
			cwd: "/",
			status: "active" as const,
			lastActivityAt: new Date(),
			createdAt: new Date(),
		}));
		const state = makeState({ sessions, configuredAgentNames: sessions.map(s => s.agentName) });
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(5); // header + 4 rows
		expect(lines[lines.length - 1]).toContain("+1 more");
	});

	it("10 sessions produce exactly 5 lines with overflow", () => {
		const sessions = Array.from({ length: 10 }, (_, i) => ({
			sessionId: `s${i}`,
			agentName: `agent${i}`,
			cwd: "/",
			status: "active" as const,
			lastActivityAt: new Date(),
			createdAt: new Date(),
		}));
		const state = makeState({ sessions, configuredAgentNames: sessions.map(s => s.agentName) });
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(5); // header + 4 rows
		expect(lines[lines.length - 1]).toContain("+6 more");
	});

	it("CB open shows on header line", () => {
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
			circuitBreakerState: "open",
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(2); // header + 1 row
		expect(lines[0]).toContain("CB:open");
	});

	it("CB half-open shows on header line", () => {
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
			circuitBreakerState: "half-open",
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("CB:half-open");
	});

	it("no separator line in output", () => {
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
				{
					sessionId: "s2",
					agentName: "claude",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
		});
		const lines = render(makeDeps(state));
		for (const line of lines) {
			expect(line).not.toContain("───");
		}
	});

	it("no hints line in output", () => {
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
		});
		const lines = render(makeDeps(state));
		for (const line of lines) {
			expect(line).not.toContain("/acp");
		}
	});

	it("no standalone summary line", () => {
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
				{
					sessionId: "s2",
					agentName: "claude",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(3); // header + 2 rows, no summary/hints/separator
	});

	// ── lastError display tests ──

	it("shows lastError on header when present with no sessions", () => {
		const state = makeState({
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: "spawn exploded",
			},
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("⚠");
		expect(lines[0]).toContain("spawn exploded");
	});

	it("shows lastError on header when present with active sessions (no session errors)", () => {
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
				{
					sessionId: "s2",
					agentName: "claude",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: "timeout",
			},
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(3); // header + 2 rows
		expect(lines[0]).toContain("⚠");
		expect(lines[0]).toContain("timeout");
	});

	it("does NOT show lastError when a session has error status", () => {
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
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: "spawn exploded",
			},
		});
		const lines = render(makeDeps(state));
		expect(lines[0]).not.toContain("⚠");
		expect(lines[0]).not.toContain("spawn exploded");
	});

	it("lastError text is truncated on narrow terminals", () => {
		const longError = "a very long error message that should be truncated because it exceeds thirty characters";
		const state = makeState({
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: longError,
			},
		});
		const lines = render(makeDeps(state), 60);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("⚠");
		expect(lines[0]).not.toContain("exceeds thirty characters");
	});

	it("lastError cleared produces no hint", () => {
		const state = makeState({
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: undefined,
			},
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(1);
		expect(lines[0]).not.toContain("⚠");
	});

	it("lastError shown alongside CB open state", () => {
		const state = makeState({
			circuitBreakerState: "open",
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				lastError: "spawn failed",
			},
		});
		const lines = render(makeDeps(state), 500);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("CB:open");
		expect(lines[0]).toContain("⚠");
		expect(lines[0]).toContain("spawn failed");
	});
	// ── Status priority tests ──

	it("status priority: error is highest", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s-err",
					agentName: "gemini",
					cwd: "/",
					status: "error",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("error");
	});

	it("status priority: active shown when no error", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s-act",
					agentName: "gemini",
					cwd: "/",
					status: "active",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("active");
		expect(joined).not.toContain("error");
	});

	it("status priority: stale shown when no error or active", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s-stale",
					agentName: "gemini",
					cwd: "/",
					status: "stale",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("stale");
		expect(joined).not.toContain("active");
		expect(joined).not.toContain("error");
	});

	it("mixed status counts in header", () => {
		const state = makeState({
			sessions: [
				{ sessionId: "a1", agentName: "g1", cwd: "/", status: "active" as const, lastActivityAt: new Date(), createdAt: new Date() },
				{ sessionId: "a2", agentName: "g2", cwd: "/", status: "active" as const, lastActivityAt: new Date(), createdAt: new Date() },
				{ sessionId: "i1", agentName: "g3", cwd: "/", status: "idle" as const, lastActivityAt: new Date(), createdAt: new Date() },
				{ sessionId: "s1", agentName: "g4", cwd: "/", status: "stale" as const, lastActivityAt: new Date(), createdAt: new Date() },
			],
			});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		// All non-zero status counts appear in header
		expect(joined).toContain("active");
		expect(joined).toContain("idle");
		expect(joined).toContain("stale");
	});

	// ── Overflow tests ──

	it("6 sessions produce exactly 5 lines with overflow", () => {
		const sessions = Array.from({ length: 6 }, (_, i) => ({
			sessionId: `s${i}`,
			agentName: `agent${i}`,
			cwd: "/",
			status: "active" as const,
			lastActivityAt: new Date(),
			createdAt: new Date(),
		}));
		const state = makeState({ sessions, configuredAgentNames: sessions.map(s => s.agentName) });
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(5); // header + 4 rows
		expect(lines[lines.length - 1]).toContain("+2 more");
	});

	// ── Session row format tests ──

	it("session row contains icon, agentName, shortId, and timeAgo", () => {
		const past = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
		const state = makeState({
			sessions: [
				{
					sessionId: "sess-abc12345",
					agentName: "gemini",
					cwd: "/",
					status: "active",
					lastActivityAt: past,
					createdAt: past,
				},
			],
			});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(2);
		const row = lines[1]; // session row
		// Icon (● for active)
		expect(row).toContain("●");
		// Agent name
		expect(row).toContain("gemini");
		// Short ID prefix
		expect(row).toContain("sess-abc");
		// Time ago text
		expect(row).toContain("ago");
	});

	it("session row with sessionName shows name inline", () => {
		const state = makeState({
			sessions: [
				{
					sessionId: "s1",
					sessionName: "alpha",
					agentName: "gemini",
					cwd: "/",
					status: "idle",
					lastActivityAt: new Date(),
					createdAt: new Date(),
				},
			],
			});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(2);
		const row = lines[1];
		expect(row).toContain("alpha");
	});

	it("session row without sessionName omits name", () => {
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
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(2);
		const row = lines[1];
		expect(row).not.toContain("undefined");
	});

	// ── Absence of old-format sections ──

	it("no delegation-history section in any render", () => {
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
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
				delegationHistory: [
					{ agentName: "claude", status: "completed", finishedAt: new Date() },
				],
			},
			});
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).not.toContain("recent");
	});
});


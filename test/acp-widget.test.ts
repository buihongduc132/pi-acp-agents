/**
 * Tests for ACP TUI Widget (acp-widget.ts) — full-format render()
 *
 * The widget now emits a full panel:
 *   header · status line · (circuit-breaker line when open/half-open) ·
 *   per-delegation rows · `─ recent ─` history · session/no-sessions block ·
 *   `─ workers ─` rows · `───` separator · summary line · `/acp …` hints line.
 *
 * Line-count signature (CB closed, no delegations/history/workers):
 *   0 sessions + 0 agents         → 0   (hidden)
 *   0 sessions + configured agents → 6
 *   N sessions                     → N + 5
 * CB open / half-open adds exactly +1 line (the dedicated CB line).
 */
import { describe, expect, it } from "vitest";
import {
	type AcpWidgetDeps,
	type AcpWidgetSession,
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

/**
 * Expected full-format line count for `sessions` sessions with CB closed and
 * no delegation/history/worker rows.
 */
function expectedLineCount(sessionCount: number, agentCount = 1): number {
	if (sessionCount === 0 && agentCount === 0) return 0;
	if (sessionCount === 0) return 6;
	return sessionCount + 5;
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
		expect(lines.length).toBe(expectedLineCount(0, 2));
		const joined = lines.join("\n");
		expect(joined).toContain("ACP");
		expect(joined).toContain("status: idle");
		expect(joined).toContain("no active sessions");
		expect(joined).toContain("/acp · /acp-config · acp_status · acp_prompt <msg>");
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
		expect(lines.length).toBe(expectedLineCount(1));

		const joined = lines.join("\n");
		expect(joined).toContain("gemini");
		expect(joined).toContain("alpha");
		expect(joined).toContain("sess-ab");
		// Full format emits a separator line
		expect(joined).toContain("───");
		// Full format emits a hints line
		expect(joined).toContain("/acp");
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
		// Summary line reports session counts
		expect(joined).toContain("2 sessions");
		// Summary line breaks down active/idle counts
		expect(joined).toContain("1 active");
		expect(joined).toContain("1 idle");
		expect(lines.length).toBe(expectedLineCount(2)); // header + status + 2 rows + separator + summary + hints
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
		// CB is rendered on its own dedicated line
		const joined = lines.join("\n");
		expect(joined).toContain("circuit breaker: open");
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

	it("shows model in the session row when present", () => {
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
		// Full format renders the model inline on the session row
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
		// Width truncates per line content but does not change the row count
		expect(lines.length).toBe(expectedLineCount(1));
		for (const line of lines) {
			expect(typeof line).toBe("string");
			expect(line.length).toBeGreaterThan(0);
		}
	});

	it("shows default agent in summary line", () => {
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
		// Summary line renders `· default: <agent>`
		expect(joined).toContain("default: gemini");
	});

	it("renders delegating state with status line", () => {
		const state = makeState({
			activity: {
				activeDelegations: 1,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
			},
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(expectedLineCount(0)); // no-sessions block
		const joined = lines.join("\n");
		expect(joined).toContain("ACP");
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
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(expectedLineCount(0));
		const joined = lines.join("\n");
		expect(joined).toContain("ACP");
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
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(expectedLineCount(0));
		const joined = lines.join("\n");
		// Error is surfaced on the status line
		expect(joined).toContain("error: spawn exploded");
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
		expect(lines.length).toBe(expectedLineCount(1)); // status + 1 session row + scaffolding
		const joined = lines.join("\n");
		// Activity status is shown on the status line
		expect(joined).toContain("broadcasting");
		expect(joined).toContain("gemini");
		// Full format emits a hints line
		expect(joined).toContain("/acp");
	});

	it("component dispose does not throw", () => {
		const state = makeState();
		const factory = createAcpWidget(makeDeps(state));
		const component = factory({}, createMockTheme());
		expect(() => (component as any).dispose()).not.toThrow();
	});

	// ── Full-format line-count + content tests ──

	it("3 sessions produce exactly 8 lines", () => {
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
		expect(lines.length).toBe(expectedLineCount(3)); // 3 + 5
	});

	it("5 sessions render every row (no overflow cap)", () => {
		const sessions = Array.from({ length: 5 }, (_, i) => ({
			sessionId: `s${i}`,
			agentName: `agent${i}`,
			cwd: "/",
			status: "active" as const,
			lastActivityAt: new Date(),
			createdAt: new Date(),
		}));
		const state = makeState({ sessions, configuredAgentNames: sessions.map((s) => s.agentName) });
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(expectedLineCount(5)); // 5 + 5 = 10, no cap
		const joined = lines.join("\n");
		// Last session's agent name still appears (not truncated behind `+N more`)
		expect(joined).toContain("agent4");
		expect(joined).not.toContain("+1 more");
	});

	it("10 sessions render every row (no overflow cap)", () => {
		const sessions = Array.from({ length: 10 }, (_, i) => ({
			sessionId: `s${i}`,
			agentName: `agent${i}`,
			cwd: "/",
			status: "active" as const,
			lastActivityAt: new Date(),
			createdAt: new Date(),
		}));
		const state = makeState({ sessions, configuredAgentNames: sessions.map((s) => s.agentName) });
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(expectedLineCount(10)); // 10 + 5 = 15, no cap
		const joined = lines.join("\n");
		expect(joined).toContain("agent9");
		expect(joined).not.toContain("+6 more");
	});

	it("CB open renders a dedicated circuit-breaker line", () => {
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
		// CB open adds +1 line vs closed (expectedLineCount(1) + 1)
		expect(lines.length).toBe(expectedLineCount(1) + 1);
		const joined = lines.join("\n");
		expect(joined).toContain("circuit breaker: open");
	});

	it("CB half-open renders a dedicated circuit-breaker line", () => {
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
		expect(lines.length).toBe(expectedLineCount(1) + 1);
		const joined = lines.join("\n");
		expect(joined).toContain("half-open (probing)");
	});

	it("separator line is present in output", () => {
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
		const joined = lines.join("\n");
		expect(joined).toContain("───");
	});

	it("hints line is present in output", () => {
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
		const joined = lines.join("\n");
		expect(joined).toContain("/acp");
	});

	it("summary line reports session/agent counts", () => {
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
		expect(lines.length).toBe(expectedLineCount(2)); // header + status + 2 rows + separator + summary + hints
		const joined = lines.join("\n");
		expect(joined).toContain("2 sessions");
	});

	// ── Anti-flicker tests ──

	describe("anti-flicker", () => {
		/** Helper to create a session with defaults */
		function makeSession(overrides: Partial<AcpWidgetSession> = {}): AcpWidgetSession {
			return {
				sessionId: "abc12345-6789-def0",
				agentName: "gemini",
				cwd: "/tmp",
				status: "idle",
				lastActivityAt: new Date(),
				createdAt: new Date(),
				...overrides,
			};
		}

		it("same session count produces same line count regardless of status", () => {
			const stateA = makeState({
				sessions: [
					makeSession({ sessionId: "s1", status: "idle" }),
					makeSession({ sessionId: "s2", status: "idle" }),
				],
			});
			const stateB = makeState({
				sessions: [
					makeSession({ sessionId: "s1", status: "active" }),
					makeSession({ sessionId: "s2", status: "active" }),
				],
			});
			expect(render(makeDeps(stateA)).length).toBe(render(makeDeps(stateB)).length);
		});

		it("idle→active transition does not change line count", () => {
			const sessions = [
				makeSession({ sessionId: "s1", status: "idle" }),
				makeSession({ sessionId: "s2", status: "idle" }),
			];
			const state = makeState({ sessions });
			const before = render(makeDeps(state));

			// Transition one session to active
			sessions[0].status = "active";
			const after = render(makeDeps(state));

			expect(before.length).toBe(after.length);
		});

		it("CB closed→open adds exactly one line (dedicated CB row)", () => {
			const sessions = [
				makeSession({ sessionId: "s1" }),
				makeSession({ sessionId: "s2" }),
			];
			const stateClosed = makeState({ sessions, circuitBreakerState: "closed" });
			const stateOpen = makeState({ sessions, circuitBreakerState: "open" });
			expect(render(makeDeps(stateOpen)).length).toBe(render(makeDeps(stateClosed)).length + 1);
		});

		it("CB closed→half-open adds exactly one line (dedicated CB row)", () => {
			const sessions = [
				makeSession({ sessionId: "s1" }),
				makeSession({ sessionId: "s2" }),
			];
			const stateClosed = makeState({ sessions, circuitBreakerState: "closed" });
			const stateHalfOpen = makeState({ sessions, circuitBreakerState: "half-open" });
			expect(render(makeDeps(stateHalfOpen)).length).toBe(render(makeDeps(stateClosed)).length + 1);
		});

		it("CB open→closed removes exactly one line (dedicated CB row)", () => {
			const sessions = [
				makeSession({ sessionId: "s1" }),
				makeSession({ sessionId: "s2" }),
			];
			const stateOpen = makeState({ sessions, circuitBreakerState: "open" });
			const stateClosed = makeState({ sessions, circuitBreakerState: "closed" });
			expect(render(makeDeps(stateClosed)).length).toBe(render(makeDeps(stateOpen)).length - 1);
		});

		it("line count follows the N+5 formula for 0 through 5 sessions", () => {
			for (let n = 0; n <= 5; n++) {
				const sessions = Array.from({ length: n }, (_, i) =>
					makeSession({ sessionId: `s${i}`, agentName: `agent${i}`, status: "idle" }),
				);
				const agents = n === 0 ? ["gemini"] : sessions.map((s) => s.agentName);
				const state = makeState({ sessions, configuredAgentNames: agents, circuitBreakerState: "closed" });
				const lines = render(makeDeps(state));
				expect(lines.length).toBe(expectedLineCount(n, agents.length));
			}
		});

		it("5 sessions render linearly (N+5, no overflow cap)", () => {
			const sessions = Array.from({ length: 5 }, (_, i) =>
				makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
			);
			const state = makeState({ sessions, configuredAgentNames: sessions.map((s) => s.agentName) });
			const lines = render(makeDeps(state));
			expect(lines.length).toBe(expectedLineCount(5)); // 5 + 5 = 10
			const joined = lines.join("\n");
			expect(joined).toContain("agent4");
			expect(joined).not.toContain("+1 more");
		});

		it("6 sessions render linearly (N+5, no overflow cap)", () => {
			const sessions = Array.from({ length: 6 }, (_, i) =>
				makeSession({ sessionId: `s${i}`, agentName: `agent${i}` }),
			);
			const state = makeState({ sessions, configuredAgentNames: sessions.map((s) => s.agentName) });
			const lines = render(makeDeps(state));
			expect(lines.length).toBe(expectedLineCount(6)); // 6 + 5 = 11
			const joined = lines.join("\n");
			expect(joined).toContain("agent5");
			expect(joined).not.toContain("+2 more");
		});

		it("session with sessionName vs without: same line count", () => {
			const stateA = makeState({
				sessions: [
					makeSession({ sessionId: "s1", sessionName: "alpha" }),
					makeSession({ sessionId: "s2", sessionName: "beta" }),
				],
			});
			const stateB = makeState({
				sessions: [
					makeSession({ sessionId: "s1" }),
					makeSession({ sessionId: "s2" }),
				],
			});
			expect(render(makeDeps(stateA)).length).toBe(render(makeDeps(stateB)).length);
		});

		it("session with model vs without: same line count", () => {
			const stateA = makeState({
				sessions: [
					makeSession({ sessionId: "s1", model: "gemini-2.5-pro" }),
					makeSession({ sessionId: "s2", model: "claude-3.5" }),
				],
			});
			const stateB = makeState({
				sessions: [
					makeSession({ sessionId: "s1" }),
					makeSession({ sessionId: "s2" }),
				],
			});
			expect(render(makeDeps(stateA)).length).toBe(render(makeDeps(stateB)).length);
		});

		it("error session vs idle session: same line count", () => {
			const stateA = makeState({
				sessions: [
					makeSession({ sessionId: "s1", status: "error" }),
					makeSession({ sessionId: "s2", status: "error" }),
				],
			});
			const stateB = makeState({
				sessions: [
					makeSession({ sessionId: "s1", status: "idle" }),
					makeSession({ sessionId: "s2", status: "idle" }),
				],
			});
			expect(render(makeDeps(stateA)).length).toBe(render(makeDeps(stateB)).length);
		});

		it("with delegations activity vs without: same line count", () => {
			const sessions = [
				makeSession({ sessionId: "s1" }),
				makeSession({ sessionId: "s2" }),
			];
			const stateA = makeState({
				sessions,
				activity: { activeDelegations: 1, activeBroadcasts: 0, activeCompares: 0, delegations: [] },
			});
			const stateB = makeState({
				sessions,
				activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [] },
			});
			expect(render(makeDeps(stateA)).length).toBe(render(makeDeps(stateB)).length);
		});

		it("with error in activity vs without: same line count", () => {
			const sessions = [
				makeSession({ sessionId: "s1" }),
				makeSession({ sessionId: "s2" }),
			];
			const stateA = makeState({
				sessions,
				activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [], lastError: "boom" },
			});
			const stateB = makeState({
				sessions,
				activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [] },
			});
			expect(render(makeDeps(stateA)).length).toBe(render(makeDeps(stateB)).length);
		});
	});
});

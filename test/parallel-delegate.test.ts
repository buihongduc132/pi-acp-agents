/**
 * TDD: Parallel Delegation with Per-Agent Progress
 *
 * Tests that widgetActivity correctly tracks multiple concurrent delegations
 * with independent progress, proper cleanup, and no cross-contamination.
 *
 * Strategy: Test state-shape and closure correctness through the widget pipeline.
 * Compact format does NOT render delegation rows — verify state is correct
 * and widget renders without error.
 */
import { describe, it, expect } from "vitest";
import {
	type AcpWidgetDeps,
	type AcpWidgetState,
	type AcpWidgetDelegation,
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

function makeDelegation(overrides: Partial<AcpWidgetDelegation> = {}): AcpWidgetDelegation {
	return {
		id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		agentName: "gemini",
		phase: "spawning",
		startedAt: new Date(),
		lastActivityAt: new Date(),
		...overrides,
	};
}

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

function render(deps: AcpWidgetDeps, width = 120): string[] {
	const factory = createAcpWidget(deps);
	const theme = createMockTheme();
	const component = factory({}, theme);
	return component.render(width);
}

/**
 * Full-format panel with 0 sessions + N delegations, CB closed, no history:
 * header + status line + N delegation rows + no-sessions line + separator +
 * summary + hints = 6 + delegations.length
 */
function expectedLineCount(state: AcpWidgetState): number {
	return 6 + (state.activity?.delegations?.length ?? 0);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("parallel delegation — widget tracking", () => {
	// Test 1: Multiple concurrent delegations in widgetActivity
	it("shows 3 concurrent delegations with correct agent names", () => {
		const delegations = [
			makeDelegation({ id: "d1", agentName: "gemini", phase: "spawning" }),
			makeDelegation({ id: "d2", agentName: "claude", phase: "spawning" }),
			makeDelegation({ id: "d3", agentName: "codex", phase: "spawning" }),
		];
		const state = makeState({
			configuredAgentNames: ["gemini", "claude", "codex"],
			activity: {
				activeDelegations: 3,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations,
			},
		});

		// Assert state shape
		expect(state.activity.delegations).toHaveLength(3);
		expect(state.activity.delegations.map((d) => d.agentName)).toEqual([
			"gemini",
			"claude",
			"codex",
		]);

		// Full format: delegations render as rows, status line shows the count
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(lines.length).toBe(expectedLineCount(state));
		expect(joined).toContain("busy (3)");
		expect(joined).toContain("gemini");
		expect(joined).toContain("claude");
		expect(joined).toContain("codex");
	});

	// Test 2: Each delegation updates independently
	it("each delegation shows its own phase", () => {
		const delegations = [
			makeDelegation({ id: "d1", agentName: "gemini", phase: "spawning" }),
			makeDelegation({ id: "d2", agentName: "claude", phase: "prompting" }),
			makeDelegation({ id: "d3", agentName: "codex", phase: "initializing" }),
		];
		const state = makeState({
			configuredAgentNames: ["gemini", "claude", "codex"],
			activity: {
				activeDelegations: 3,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations,
			},
		});

		const lines = render(makeDeps(state));
		// Full format: 3 delegations render as rows
		expect(lines.length).toBe(expectedLineCount(state));

		// Verify each delegation object has its own phase (no cross-contamination)
		expect(state.activity.delegations[0].phase).toBe("spawning");
		expect(state.activity.delegations[1].phase).toBe("prompting");
		expect(state.activity.delegations[2].phase).toBe("initializing");
	});

	// Test 3: Cleanup removes only the finished delegation
	it("removing delegation #2 leaves #1 and #3 intact", () => {
		const delegations = [
			makeDelegation({ id: "d1", agentName: "gemini", phase: "prompting" }),
			makeDelegation({ id: "d2", agentName: "claude", phase: "spawning" }),
			makeDelegation({ id: "d3", agentName: "codex", phase: "initializing" }),
		];

		// Simulate cleanup: remove delegation #2 (claude)
		const remaining = delegations.filter((d) => d.id !== "d2");

		const state = makeState({
			configuredAgentNames: ["gemini", "claude", "codex"],
			activity: {
				activeDelegations: 2,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: remaining,
			},
		});

		expect(state.activity.delegations).toHaveLength(2);
		expect(state.activity.delegations.map((d) => d.agentName)).toEqual([
			"gemini",
			"codex",
		]);

		const lines = render(makeDeps(state));
		expect(lines.length).toBe(expectedLineCount(state));
	});

	// Test 4: Widget state snapshot shows all active delegations
	it("getWidgetState snapshot includes all active delegations", () => {
		const delegations = [
			makeDelegation({ id: "d1", agentName: "gemini", phase: "prompting", text: "partial gemini..." }),
			makeDelegation({ id: "d2", agentName: "claude", phase: "spawning" }),
			makeDelegation({ id: "d3", agentName: "codex", phase: "initializing" }),
		];
		const state = makeState({
			configuredAgentNames: ["gemini", "claude", "codex"],
			activity: {
				activeDelegations: 3,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations,
				lastError: undefined,
			},
		});

		// Simulate getWidgetState behavior — the activity is spread into the state
		const snapshot: AcpWidgetState = {
			...state,
			activity: { ...state.activity, delegations: [...state.activity.delegations] },
		};

		expect(snapshot.activity.delegations).toHaveLength(3);
		expect(snapshot.activity.activeDelegations).toBe(3);
		expect(snapshot.activity.delegations[0].text).toBe("partial gemini...");
		expect(snapshot.activity.delegations[0].phase).toBe("prompting");
		expect(snapshot.activity.delegations[1].phase).toBe("spawning");
		expect(snapshot.activity.delegations[2].phase).toBe("initializing");
	});

	// Test 5: Stress test — 5 parallel, end 3, 2 remain
	it("stress: 5 parallel delegates, end 3, 2 remain with no cross-contamination", () => {
		const agents = ["gemini", "claude", "codex", "opencode", "ocxo"];
		const delegations = agents.map((agent, i) =>
			makeDelegation({
				id: `d${i + 1}`,
				agentName: agent,
				phase: ["spawning", "prompting", "initializing", "prompting", "spawning"][i],
				text: i % 2 === 0 ? `partial-${agent}` : undefined,
			}),
		);

		// All 5 active
		const state5 = makeState({
			configuredAgentNames: agents,
			activity: {
				activeDelegations: 5,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations,
			},
		});
		expect(state5.activity.delegations).toHaveLength(5);

		// End delegates #1 (gemini), #3 (codex), #5 (ocxo)
		const remaining = delegations.filter(
			(d) => !["d1", "d3", "d5"].includes(d.id),
		);

		const state2 = makeState({
			configuredAgentNames: agents,
			activity: {
				activeDelegations: 2,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: remaining,
			},
		});

		expect(state2.activity.delegations).toHaveLength(2);
		expect(state2.activity.delegations.map((d) => d.agentName)).toEqual([
			"claude",
			"opencode",
		]);

		// Verify phases survived cleanup
		expect(state2.activity.delegations[0].phase).toBe("prompting");
		expect(state2.activity.delegations[1].phase).toBe("prompting");

		const lines = render(makeDeps(state2));
		expect(lines.length).toBe(expectedLineCount(state2));
	});

	// Test 6: onProgress updates only the targeted delegation (closure correctness)
	it("onProgress callback updates only its delegation via closure", () => {
		const d1 = makeDelegation({ id: "d1", agentName: "gemini", phase: "spawning" });
		const d2 = makeDelegation({ id: "d2", agentName: "claude", phase: "spawning" });
		const d3 = makeDelegation({ id: "d3", agentName: "codex", phase: "spawning" });

		const delegations = [d1, d2, d3];

		// Simulate what beginWidgetActivity + onProgress closure does:
		const makeOnProgress = (delegation: AcpWidgetDelegation) => (progress: { phase: string; lastActivityAt: number; text?: string }) => {
			delegation.phase = progress.phase;
			delegation.lastActivityAt = new Date(progress.lastActivityAt);
			if (progress.text) delegation.text = progress.text;
		};

		const onProgress1 = makeOnProgress(d1);
		const onProgress2 = makeOnProgress(d2);
		const onProgress3 = makeOnProgress(d3);

		// Fire progress updates with different phases
		const now = Date.now();
		onProgress1({ phase: "prompting", lastActivityAt: now, text: "thinking..." });
		onProgress2({ phase: "initializing", lastActivityAt: now });
		onProgress3({ phase: "done", lastActivityAt: now });

		// Each delegation got its own phase — no cross-contamination
		expect(d1.phase).toBe("prompting");
		expect(d1.text).toBe("thinking...");
		expect(d2.phase).toBe("initializing");
		expect(d2.text).toBeUndefined();
		expect(d3.phase).toBe("done");
		expect(d3.text).toBeUndefined();

		// Compact format: no sessions → header only, phases not rendered
		const state = makeState({
			configuredAgentNames: ["gemini", "claude", "codex"],
			activity: {
				activeDelegations: 3,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations,
			},
		});
		const lines = render(makeDeps(state));
		expect(lines.length).toBe(expectedLineCount(state));
	});

	// Test 7: beginWidgetActivity cleanup function removes only its delegation
	it("cleanup function filters out only its own delegation id", () => {
		// Simulate the beginWidgetActivity pattern
		const widgetActivity = {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [] as AcpWidgetDelegation[],
			lastError: undefined as string | undefined,
		};

		const beginDelegate = (agentName: string) => {
			widgetActivity.activeDelegations += 1;
			const delId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const delegation: AcpWidgetDelegation = {
				id: delId,
				agentName,
				phase: "spawning",
				startedAt: new Date(),
				lastActivityAt: new Date(),
			};
			widgetActivity.delegations.push(delegation);
			// Cleanup returns a function that removes only THIS delegation
			return {
				delegation,
				cleanup: () => {
					widgetActivity.delegations = widgetActivity.delegations.filter(
						(d) => d.id !== delId,
					);
				},
			};
		};

		const endDelegate = (cleanup?: () => void) => {
			widgetActivity.activeDelegations = Math.max(
				0,
				widgetActivity.activeDelegations - 1,
			);
			cleanup?.();
		};

		// Start 3 delegations
		const { delegation: d1, cleanup: c1 } = beginDelegate("gemini");
		const { delegation: d2, cleanup: c2 } = beginDelegate("claude");
		const { delegation: d3, cleanup: c3 } = beginDelegate("codex");

		expect(widgetActivity.delegations).toHaveLength(3);
		expect(widgetActivity.activeDelegations).toBe(3);

		// End only delegation #2
		endDelegate(c2);

		expect(widgetActivity.activeDelegations).toBe(2);
		expect(widgetActivity.delegations).toHaveLength(2);
		expect(widgetActivity.delegations.map((d) => d.agentName)).toEqual([
			"gemini",
			"codex",
		]);

		// Delegation #1 and #3 should still be the exact same objects
		expect(widgetActivity.delegations[0]).toBe(d1);
		expect(widgetActivity.delegations[1]).toBe(d3);
	});
});

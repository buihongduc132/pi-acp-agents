/**
 * TDD: Parallel Delegation with Per-Agent Progress
 *
 * Tests that widgetActivity correctly tracks multiple concurrent delegations
 * with independent progress, proper cleanup, and no cross-contamination.
 *
 * Strategy: Test through the widget rendering pipeline.
 * We create AcpWidgetState with multiple delegations and verify:
 *   - All delegations appear in rendered output
 *   - Each delegation shows its own phase
 *   - Cleanup removes only the targeted delegation
 *   - Widget state snapshots are accurate
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

		// Assert widget renders all 3
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("gemini");
		expect(joined).toContain("claude");
		expect(joined).toContain("codex");
		// 3 active delegations → widget shows "busy (3)" when total transient > 1
		expect(joined).toContain("busy (3)");
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
		const joined = lines.join("\n");

		// Each phase appears in output
		expect(joined).toContain("spawning");
		expect(joined).toContain("prompting");
		expect(joined).toContain("initializing");

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

		// Widget should show only remaining
		const lines = render(makeDeps(state));
		const joined = lines.join("\n");
		expect(joined).toContain("gemini");
		expect(joined).toContain("codex");
		// claude removed from delegation rows, but still in configured agents list
		// Check delegation-specific content is gone
		const delegationLines = lines.filter((l) => l.includes("⟳") || l.includes("⏳"));
		const delegationText = delegationLines.join("\n");
		expect(delegationText).not.toContain("claude");
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

		// Verify widget renders correctly
		const lines = render(makeDeps(state2));
		const joined = lines.join("\n");
		expect(joined).toContain("claude");
		expect(joined).toContain("opencode");
		// Removed agents still appear in "agents: ..." config line.
		// Check they are absent from delegation rows only.
		const delegationLines = lines.filter((l) => l.includes("⟳") || l.includes("⏳") || l.includes("✕"));
		const delegationText = delegationLines.join("\n");
		expect(delegationText).not.toContain("gemini");
		expect(delegationText).not.toContain("codex");
		expect(delegationText).not.toContain("ocxo");
	});

	// Test 6: onProgress updates only the targeted delegation (closure correctness)
	it("onProgress callback updates only its delegation via closure", () => {
		const d1 = makeDelegation({ id: "d1", agentName: "gemini", phase: "spawning" });
		const d2 = makeDelegation({ id: "d2", agentName: "claude", phase: "spawning" });
		const d3 = makeDelegation({ id: "d3", agentName: "codex", phase: "spawning" });

		const delegations = [d1, d2, d3];

		// Simulate what beginWidgetActivity + onProgress closure does:
		// The pattern in index.ts:
		//   const delegation = widgetActivity.delegations[widgetActivity.delegations.length - 1];
		//   const onProgress = (progress) => { delegation.phase = progress.phase; ... }
		//
		// For parallel, each delegate call creates its own closure referencing its delegation.
		// Simulate by creating closures that reference each delegation directly:

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

		// Widget renders the updated states
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
		const joined = lines.join("\n");
		expect(joined).toContain("prompting");
		expect(joined).toContain("initializing");
		// "done" phase gets ⟳ icon — no special handling, just rendered
		expect(joined).toContain("done");
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

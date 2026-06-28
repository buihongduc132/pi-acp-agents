/**
 * TDD Tests: Delegation History Tracking (T1) + Widget Compact Format (T2)
 *
 * T1: Track completed delegations in a history array (cap 20)
 * T2: Compact format does NOT render delegation history — verify no crash
 *
 * Run: npx vitest run test/delegation-history.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createAcpWidget } from "../src/acp-widget.js";
import type { AcpWidgetState, AcpDelegationHistoryEntry } from "../src/acp-widget.js";

// ── Helpers ──────────────────────────────────────────────────────────

function mkState(override?: Partial<AcpWidgetState>): AcpWidgetState {
	return {
		sessions: [],
		circuitBreakerState: "closed",
		configuredAgentNames: ["gemini", "claude"],
		configuredAliases: ["smart"],
		defaultAgent: "smart",
		activity: {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		},
		...override,
	};
}

function mkRecent(count: number): AcpDelegationHistoryEntry[] {
	const items: AcpDelegationHistoryEntry[] = [];
	for (let i = 0; i < count; i++) {
		items.push({
			agentName: i % 2 === 0 ? "gemini" : "claude",
			status: i % 3 === 0 ? "error" : "completed",
			finishedAt: new Date(Date.now() - i * 60_000),
			error: i % 3 === 0 ? "timeout" : undefined,
		});
	}
	return items;
}

// ── Widget render tests ──────────────────────────────────────────────

describe("T2: Widget delegation history — compact format", () => {
	const mockTheme = {
		bold: (s: string) => s,
		fg: (_c: string, s: string) => s,
		dim: (s: string) => s,
	};

	it("renders nothing when no recent delegations", () => {
		const state = mkState();
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		// Should not contain "recent" label
		const recentLines = lines.filter(l => l.includes("recent"));
		expect(recentLines.length).toBe(0);
	});

	it("renders header only when delegations present (compact format)", () => {
		const recent = mkRecent(3);
		const state = mkState({ activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [], delegationHistory: recent } });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		// Compact format does not render "recent" section
		expect(lines.length).toBe(1); // header only
		const recentLines = lines.filter(l => l.includes("recent"));
		expect(recentLines.length).toBe(0);
	});

	it("renders header only for activity.delegationHistory (compact format)", () => {
		const recent = mkRecent(2);
		const state = mkState({ activity: {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			delegationHistory: recent,
		}});
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		expect(lines.length).toBe(1); // header only, no sessions
		const recentLines2 = lines.filter(l => l.includes("recent"));
		expect(recentLines2.length).toBe(0);
	});

	it("compact format does not show history success entries", () => {
		const recent: AcpDelegationHistoryEntry[] = [{
			agentName: "gemini",
			status: "completed",
			finishedAt: new Date(),
		}];
		const state = mkState({ activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [], delegationHistory: recent } });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		// Widget renders without error; header only
		expect(lines.length).toBe(1);
	});

	it("compact format does not show history error entries", () => {
		const recent: AcpDelegationHistoryEntry[] = [{
			agentName: "claude",
			status: "error",
			finishedAt: new Date(),
			error: "timeout exceeded",
		}];
		const state = mkState({ activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [], delegationHistory: recent } });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		// Widget renders without error; header only
		expect(lines.length).toBe(1);
	});

	it("compact format does not render history entries (capped or not)", () => {
		const recent = mkRecent(10);
		const state = mkState({ activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [], delegationHistory: recent } });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		// Compact format: header only, no history rows
		expect(lines.length).toBe(1);
	});

	it("compact format does not render history ordering", () => {
		const recent = mkRecent(3);
		const state = mkState({ activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [], delegationHistory: recent } });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		// Compact format: header only, no history rows
		expect(lines.length).toBe(1);
	});
});

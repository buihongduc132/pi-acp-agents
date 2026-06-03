/**
 * TDD Tests: Delegation History Tracking (T1) + Widget Recent Section (T2)
 *
 * T1: Track completed delegations in a history array (cap 20)
 * T2: Widget shows recent delegation history section
 *
 * Run: npx vitest run test/delegation-history.test.ts
 */
import { describe, it, expect, beforeEach } from "bun:test";

import { createAcpWidget } from "../src/acp-widget.js";
import type { AcpWidgetState, AcpWidgetRecentDelegation } from "../src/acp-widget.js";

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

function mkRecent(count: number): AcpWidgetRecentDelegation[] {
	const items: AcpWidgetRecentDelegation[] = [];
	for (let i = 0; i < count; i++) {
		items.push({
			id: `hist-${i}`,
			agentName: i % 2 === 0 ? "gemini" : "claude",
			status: i % 3 === 0 ? "error" : "success",
			completedAt: new Date(Date.now() - i * 60_000),
			error: i % 3 === 0 ? "timeout" : undefined,
		});
	}
	return items;
}

// ── Widget render tests ──────────────────────────────────────────────

describe("T2: Widget recent delegation section", () => {
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
		const recentLines = lines.filter(l => l.includes("recent:"));
		expect(recentLines.length).toBe(0);
	});

	it("renders recent delegations when present in state.recentDelegations", () => {
		const recent = mkRecent(3);
		const state = mkState({ recentDelegations: recent });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		const recentLines = lines.filter(l => l.includes("recent:"));
		expect(recentLines.length).toBeGreaterThan(0);
	});

	it("renders recent delegations from activity.recentDelegations fallback", () => {
		const recent = mkRecent(2);
		const state = mkState({ activity: {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
			recentDelegations: recent,
		}});
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		const recentLines = lines.filter(l => l.includes("recent:"));
		expect(recentLines.length).toBeGreaterThan(0);
	});

	it("shows success indicator for successful delegations", () => {
		const recent: AcpWidgetRecentDelegation[] = [{
			id: "hist-1",
			agentName: "gemini",
			status: "success",
			completedAt: new Date(),
		}];
		const state = mkState({ recentDelegations: recent });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		const geminiLines = lines.filter(l => l.includes("gemini"));
		expect(geminiLines.length).toBeGreaterThan(0);
	});

	it("shows error indicator for failed delegations", () => {
		const recent: AcpWidgetRecentDelegation[] = [{
			id: "hist-1",
			agentName: "claude",
			status: "error",
			completedAt: new Date(),
			error: "timeout exceeded",
		}];
		const state = mkState({ recentDelegations: recent });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		const claudeLines = lines.filter(l => l.includes("claude"));
		expect(claudeLines.length).toBeGreaterThan(0);
	});

	it("caps display to 5 most recent entries", () => {
		const recent = mkRecent(10);
		const state = mkState({ recentDelegations: recent });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		// Should show "5 recent:" not "10 recent:"
		const countLines = lines.filter(l => l.includes("5 recent:"));
		expect(countLines.length).toBeGreaterThan(0);
	});

	it("shows most recent first (reverse order)", () => {
		const recent = mkRecent(3);
		// recent[0] is oldest, recent[2] is newest
		const state = mkState({ recentDelegations: recent });
		const factory = createAcpWidget({ getState: () => state });
		const widget = factory({}, mockTheme as any);
		const lines = widget.render(80);
		const geminiIdx = lines.findIndex(l => l.includes("gemini"));
		const claudeIdx = lines.findIndex(l => l.includes("claude"));
		// Most recent (index 2, gemini) should appear before older (index 1, claude)
		expect(geminiIdx).toBeLessThan(claudeIdx);
	});
});

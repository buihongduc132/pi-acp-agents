/**
 * Test for task 4.5: "empty dags array `[]` → no DAG section renders
 * (no header)".
 *
 * Spec scenario (dag-monitoring/spec.md — "Widget has no DAGs at all"):
 *   WHEN `DagStore.listAll()` returns an empty list and no DAG has ever been
 *   submitted
 *   THEN the widget SHALL NOT render any DAG section. The widget layout SHALL
 *   be identical to the current pre-change rendering (sessions + circuit
 *   breaker + delegations + workers only).
 *
 * This exercises BOTH the helper contract (renderDagSection returns "" for an
 * empty array) and the full widget render() composition (no "DAGs" header,
 * no DAG rows, no DAG summary leak) when `dags` is explicitly set to `[]`.
 * It is distinct from the `dags: undefined` regression guard (task 4.2) and
 * the header-absence helper assertion (task 2.5): task 4.5 locks the explicit
 * empty-array case at the section level.
 */
import { describe, it, expect } from "vitest";
import {
	renderDagSection,
	createAcpWidget,
	type AcpWidgetState,
	type AcpWidgetSession,
	type AcpWidgetDeps,
} from "../src/acp-widget.js";

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

/**
 * Deterministic pre-change line count (CB closed, no delegations/workers):
 *  - 0 sessions + configured agents → 6
 * Compact format line counts:
 *  - 0 sessions with configured agents → 1 header + 1 no-sessions line = 2
 *  - N sessions (N ≥ 1) → 1 header + min(N, 4) session rows
 * An explicit `dags: []` MUST NOT alter this layout.
 */
function expectedLineCount(sessions: AcpWidgetSession[]): number {
	if (sessions.length === 0) return 1; // header only (no session rows)
	return 1 + Math.min(sessions.length, 4); // header + session rows (capped at 4)
}

describe("task 4.5 — empty dags array `[]` → no DAG section renders", () => {
	it("renderDagSection returns empty string for an explicit empty dags array", () => {
		const state = makeState({ dags: [] });
		expect(renderDagSection(state)).toBe("");
	});

	it("full widget render: no 'DAGs' header when dags is `[]`", () => {
		const session = makeSession();
		const state = makeState({ sessions: [session], dags: [] });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		expect(joined).not.toContain("DAGs");
	});

	it("full widget render: no DAG rows or summary leak when dags is `[]`", () => {
		const session = makeSession();
		const state = makeState({ sessions: [session], dags: [] });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		// No progress bar, wave marker, fail marker, or `:✓`/`:✕` summary pairs.
		expect(joined).not.toContain("wave ");
		expect(joined).not.toContain("[fail:");
		expect(joined).not.toMatch(/:✓/);
		expect(joined).not.toMatch(/:✕/);
	});

	it("explicit `dags: []` layout identical to pre-change (no extra lines)", () => {
		const sessions = [makeSession()];
		const linesUndefined = renderWidget(makeState({ sessions }));
		const linesEmpty = renderWidget(makeState({ sessions, dags: [] }));

		// Identical line count and identical content.
		expect(linesEmpty.length).toBe(expectedLineCount(sessions));
		expect(linesEmpty).toEqual(linesUndefined);
	});

	it("explicit `dags: []` with 0 sessions → still no DAG section", () => {
		const state = makeState({ sessions: [], configuredAgentNames: ["gemini"], dags: [] });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		expect(joined).not.toContain("DAGs");
		expect(lines.length).toBe(expectedLineCount([]));
	});
});

/**
 * Test for task 4.4: "completed/failed DAGs only, no running → renders
 * collapsed summary `<id>:✓ <id>:✕`".
 *
 * Spec scenario (dag-monitoring/spec.md — "Widget renders no running DAGs"):
 *   WHEN no DAG is running but at least one completed/failed DAG exists within
 *   the recent history window
 *   THEN the widget SHALL render a collapsed one-line summary listing each
 *   recent DAG as `<dagId>:<status-icon>` (e.g., `a1b2c3:✓ d4e5f6:✕`).
 *
 * This exercises the section-level render path (renderDagSection →
 * renderDagSummary) through the full widget render() composition, so it also
 * guards that the "DAGs" header appears and no per-DAG progress rows leak in
 * when no DAG is running.
 */
import { describe, it, expect } from "vitest";
import {
	renderDagSection,
	createAcpWidget,
	type AcpWidgetState,
	type AcpWidgetDag,
	type AcpWidgetDeps,
} from "../src/acp-widget.js";

function minutesAgo(min: number): Date {
	return new Date(Date.now() - min * 60_000);
}

function makeDag(overrides: Partial<AcpWidgetDag> = {}): AcpWidgetDag {
	return {
		dagId: "dag1",
		status: "completed",
		total: 3,
		completed: 3,
		failed: 0,
		cancelled: 0,
		createdAt: minutesAgo(10),
		updatedAt: minutesAgo(1),
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

const mockTheme: any = {
	bold: (s: string) => `<b>${s}</>`,
	fg: (color: string, s: string) => `<${color}>${s}</>`,
};

function renderWidget(state: AcpWidgetState): string[] {
	const deps: AcpWidgetDeps = { getState: () => state };
	const factory = createAcpWidget(deps);
	const widget = factory({}, mockTheme);
	return widget.render(120);
}

describe("task 4.4 — completed/failed only (no running) → collapsed summary", () => {
	it("renderDagSection returns the collapsed `<id>:<icon>` summary", () => {
		const dags: AcpWidgetDag[] = [
			makeDag({ dagId: "a1b2c3", status: "completed" }),
			makeDag({
				dagId: "d4e5f6",
				status: "failed",
				completed: 1,
				failed: 2,
			}),
		];
		const state = makeState({ dags });

		expect(renderDagSection(state)).toBe("a1b2c3:✓ d4e5f6:✕");
	});

	it("full widget render surfaces the summary line + DAGs header, no progress rows", () => {
		const dags: AcpWidgetDag[] = [
			makeDag({ dagId: "a1b2c3", status: "completed" }),
			makeDag({
				dagId: "d4e5f6",
				status: "failed",
				completed: 1,
				failed: 2,
			}),
		];
		const state = makeState({ dags });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		// Collapsed summary appears verbatim.
		expect(joined).toContain("a1b2c3:✓");
		expect(joined).toContain("d4e5f6:✕");

		// DAGs header is rendered (section is non-empty).
		expect(joined).toContain("DAGs");

		// No per-DAG progress rows should leak in (no running DAG).
		expect(joined).not.toContain("wave ");
		expect(joined).not.toContain("[fail:");
	});

	it("single completed DAG → summary is `<id>:✓`", () => {
		const state = makeState({
			dags: [makeDag({ dagId: "solo", status: "completed" })],
		});
		expect(renderDagSection(state)).toBe("solo:✓");
	});

	it("single failed DAG → summary is `<id>:✕`", () => {
		const state = makeState({
			dags: [
				makeDag({
					dagId: "boom",
					status: "failed",
					completed: 0,
					failed: 3,
				}),
			],
		});
		expect(renderDagSection(state)).toBe("boom:✕");
	});
});

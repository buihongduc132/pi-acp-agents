/**
 * Test for task 4.6: ">5 DAGs → only 5 most-recent rendered".
 *
 * Spec / design D2: Render all running/recent DAGs ... up to a hard cap of 5
 * entries, ordered by `updatedAt` descending. Prevents pathological render
 * cases (user submits 50 DAGs).
 *
 * Behavior under test: when `renderDagSection` receives a state with more than
 * 5 DAGs, it MUST render only the 5 most-recent (by `updatedAt` descending).
 */
import { describe, it, expect } from "vitest";
import {
	renderDagSection,
	type AcpWidgetState,
	type AcpWidgetDag,
} from "../src/acp-widget.js";

function makeDag(overrides: Partial<AcpWidgetDag>): AcpWidgetDag {
	return {
		dagId: "dag",
		status: "running",
		total: 3,
		completed: 1,
		failed: 0,
		cancelled: 0,
		createdAt: new Date(Date.now() - 20 * 60_000),
		updatedAt: new Date(Date.now() - 1 * 60_000),
		...overrides,
	};
}

describe("task 4.6 — >5 DAGs renders only the 5 most-recent", () => {
	it("caps running DAG rows at 5, newest by updatedAt first", () => {
		// d0 oldest ... d6 newest
		const dags: AcpWidgetDag[] = [];
		for (let i = 0; i < 7; i++) {
			dags.push(
				makeDag({
					dagId: `d${i}`,
					updatedAt: new Date(Date.now() - (7 - i) * 60_000),
				}),
			);
		}
		const state: AcpWidgetState = {
			sessions: [],
			circuitBreakerState: "closed",
			configuredAgentNames: ["gemini"],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
			},
			dags,
		};

		const out = renderDagSection(state);
		const rows = out.split("\n");

		// Exactly 5 rows rendered (the cap).
		expect(rows).toHaveLength(5);

		// The 5 most-recent by updatedAt desc → d6, d5, d4, d3, d2.
		const renderedIds = rows.map((r) => r.split(" ")[1]);
		expect(renderedIds).toEqual(["d6", "d5", "d4", "d3", "d2"]);

		// d0 and d1 (the two oldest) MUST NOT be rendered.
		expect(out).not.toContain("d0");
		expect(out).not.toContain("d1");
	});

	it("caps summary (non-running) DAG pairs at 5, newest by updatedAt first", () => {
		// All completed — exercises the renderDagSummary path.
		const dags: AcpWidgetDag[] = [];
		for (let i = 0; i < 7; i++) {
			dags.push(
				makeDag({
					dagId: `d${i}`,
					status: "completed",
					updatedAt: new Date(Date.now() - (7 - i) * 60_000),
				}),
			);
		}
		const state: AcpWidgetState = {
			sessions: [],
			circuitBreakerState: "closed",
			configuredAgentNames: ["gemini"],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
			},
			dags,
		};

		const out = renderDagSection(state);
		const pairs = out.split(" ");

		// Exactly 5 pairs rendered (the cap), newest first.
		expect(pairs).toHaveLength(5);
		expect(pairs).toEqual(["d6:✓", "d5:✓", "d4:✓", "d3:✓", "d2:✓"]);

		// The two oldest MUST NOT appear.
		expect(out).not.toContain("d0");
		expect(out).not.toContain("d1");
	});
});

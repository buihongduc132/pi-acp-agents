/**
 * Test for task 2.5: A "DAGs" header line is rendered above the DAG section
 * ONLY when DAG rows are rendered. When the section is empty, no header
 * appears.
 */
import { describe, it, expect } from "vitest";
import {
	createAcpWidget,
	type AcpWidgetState,
	type AcpWidgetSession,
	type AcpWidgetDag,
	type AcpWidgetDeps,
} from "../src/acp-widget.js";

const mockTheme: any = {
	bold: (s: string) => `<b>${s}</>`,
	fg: (color: string, s: string) => `<${color}>${s}</>`,
};

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

function makeDag(overrides: Partial<AcpWidgetDag> = {}): AcpWidgetDag {
	return {
		dagId: "dag1",
		status: "running",
		total: 5,
		completed: 2,
		failed: 0,
		cancelled: 0,
		createdAt: new Date(Date.now() - 120_000),
		updatedAt: new Date(Date.now() - 60_000),
		...overrides,
	};
}

function renderWidget(state: AcpWidgetState): string[] {
	const deps: AcpWidgetDeps = { getState: () => state };
	const factory = createAcpWidget(deps);
	const widget = factory({}, mockTheme);
	return widget.render(120);
}

describe("task 2.5 — DAGs header above section when rows render", () => {
	it("renders a 'DAGs' header line above the section when DAG rows are rendered", () => {
		const session = makeSession();
		const dag = makeDag({ dagId: "mydag", status: "running", completed: 1, total: 3 });
		const state = makeState({ sessions: [session], dags: [dag] });
		const lines = renderWidget(state);

		const headerIdx = lines.findIndex((l) => l.includes("DAGs"));
		const dagRowIdx = lines.findIndex((l) => l.includes("mydag"));

		expect(headerIdx).toBeGreaterThan(-1);
		expect(dagRowIdx).toBeGreaterThan(-1);
		// Header must appear strictly above the DAG rows
		expect(headerIdx).toBeLessThan(dagRowIdx);
	});

	it("does NOT render a 'DAGs' header when section is empty (no dags field)", () => {
		const session = makeSession();
		const state = makeState({ sessions: [session] });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		expect(joined).not.toContain("DAGs");
	});

	it("does NOT render a 'DAGs' header when dags is an empty array", () => {
		const session = makeSession();
		const state = makeState({ sessions: [session], dags: [] });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		expect(joined).not.toContain("DAGs");
	});

	it("renders the 'DAGs' header above the collapsed summary for recent DAGs", () => {
		const session = makeSession();
		const completed = makeDag({ dagId: "done1", status: "completed", completed: 3, total: 3 });
		const state = makeState({ sessions: [session], dags: [completed] });
		const lines = renderWidget(state);

		const headerIdx = lines.findIndex((l) => l.includes("DAGs"));
		const summaryIdx = lines.findIndex((l) => l.includes("done1"));

		expect(headerIdx).toBeGreaterThan(-1);
		expect(summaryIdx).toBeGreaterThan(-1);
		expect(headerIdx).toBeLessThan(summaryIdx);
	});
});

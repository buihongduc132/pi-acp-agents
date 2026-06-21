/**
 * Test for task 2.4: renderDagSection(state) is called within the widget's
 * render() composition, placed after sessions and before workers.
 */
import { describe, it, expect } from "vitest";
import {
	createAcpWidget,
	type AcpWidgetState,
	type AcpWidgetSession,
	type AcpWidgetDag,
	type AcpWidgetWorker,
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

function makeWorker(overrides: Partial<AcpWidgetWorker> = {}): AcpWidgetWorker {
	return {
		name: "worker1",
		agentName: "gemini",
		status: "busy",
		tokenCountTotal: 1000,
		toolCallCount: 5,
		ageSeconds: 30,
		stale: false,
		...overrides,
	};
}

function renderWidget(state: AcpWidgetState): string[] {
	const deps: AcpWidgetDeps = { getState: () => state };
	const factory = createAcpWidget(deps);
	const widget = factory({}, mockTheme);
	return widget.render(120);
}

describe("task 2.4 — renderDagSection wired into render()", () => {
	it("renders DAG rows when state has running DAGs", () => {
		const session = makeSession();
		const dag = makeDag({ dagId: "abc123", completed: 2, failed: 1, total: 5, currentWave: 2, totalWaves: 3 });
		const state = makeState({ sessions: [session], dags: [dag] });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		// DAG row should appear (progress bar format: filled = completed + failed = 3)
		expect(joined).toContain("[███░░] 2/5");
		expect(joined).toContain("abc123");
		expect(joined).toContain("wave 2/3");
		expect(joined).toContain("[fail:1]");
	});

	it("DAG section appears between sessions section and workers section", () => {
		const session = makeSession({ sessionId: "sess-abc", agentName: "myagent" });
		const dag = makeDag({ dagId: "mydag", status: "running", completed: 1, total: 3 });
		const worker = makeWorker({ name: "myworker" });
		const state = makeState({ sessions: [session], dags: [dag], workers: [worker] });
		const lines = renderWidget(state);

		// Find line indices for each section
		const sessionLineIdx = lines.findIndex((l) => l.includes("myagent"));
		const dagLineIdx = lines.findIndex((l) => l.includes("mydag"));
		const workerHeaderIdx = lines.findIndex((l) => l.includes("workers"));

		// DAG section should be after session and before workers
		expect(sessionLineIdx).toBeGreaterThan(-1);
		expect(dagLineIdx).toBeGreaterThan(-1);
		expect(workerHeaderIdx).toBeGreaterThan(-1);
		expect(dagLineIdx).toBeGreaterThan(sessionLineIdx);
		expect(dagLineIdx).toBeLessThan(workerHeaderIdx);
	});

	it("no DAG section when dags is undefined", () => {
		const session = makeSession();
		const state = makeState({ sessions: [session] });
		const lines = renderWidget(state);
		const joined = lines.join("\n");

		// No DAG-related content should appear
		expect(joined).not.toContain("DAGs");
		expect(joined).not.toContain("[fail:");
	});
});

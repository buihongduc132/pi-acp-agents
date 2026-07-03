/**
 * Tests for src/tui/panel-deps.ts — read-only adapter that maps the widget's
 * existing AcpWidgetState (sessions + workers) into the unified AcpPanelEntity[]
 * the interactive panel consumes.
 *
 * RED phase: tests written before implementation.
 */
import { describe, it, expect } from "vitest";
import {
	buildAcpPanelDepsReadOnly,
	type ReadOnlyPanelSources,
} from "../../src/tui/panel-deps.js";
import type { AcpWidgetState, AcpWidgetSession, AcpWidgetWorker } from "../../src/acp-widget.js";
import type { AcpPanelEntity, AcpPanelTask } from "../../src/tui/acp-panel.js";

function mkSession(over: Partial<AcpWidgetSession> = {}): AcpWidgetSession {
	return {
		sessionId: "ses_1",
		agentName: "pi",
		cwd: "/tmp",
		status: "idle",
		lastActivityAt: new Date("2026-07-04T01:00:00Z"),
		createdAt: new Date("2026-07-04T00:00:00Z"),
		...over,
	};
}

function mkWorker(over: Partial<AcpWidgetWorker> = {}): AcpWidgetWorker {
	return {
		name: "wave1",
		agentName: "pi",
		status: "idle",
		tokenCountTotal: 0,
		toolCallCount: 0,
		ageSeconds: 5,
		stale: false,
		...over,
	};
}

function mkState(over: Partial<AcpWidgetState> = {}): AcpWidgetState {
	return {
		sessions: [],
		circuitBreakerState: "closed",
		configuredAgentNames: ["pi"],
		activity: {
			activeDelegations: 0,
			activeBroadcasts: 0,
			activeCompares: 0,
			delegations: [],
		},
		...over,
	};
}

describe("buildAcpPanelDepsReadOnly", () => {
	it("maps each session to a unified entity", () => {
		const deps = buildAcpPanelDepsReadOnly({
			state: mkState({ sessions: [mkSession({ sessionId: "ses_a", sessionName: "alice", agentName: "pi", status: "active" })] }),
			tasks: [],
		});
		const entities = deps.getEntities();
		expect(entities).toHaveLength(1);
		expect(entities[0]!.id).toBe("ses_a");
		expect(entities[0]!.name).toBe("alice");
		expect(entities[0]!.status).toBe("active");
	});

	it("falls back to agentName when sessionName missing", () => {
		const deps = buildAcpPanelDepsReadOnly({
			state: mkState({ sessions: [mkSession({ sessionId: "ses_b", sessionName: undefined, agentName: "claude" })] }),
			tasks: [],
		});
		expect(deps.getEntities()[0]!.name).toBe("claude");
	});

	it("maps each worker to a unified entity", () => {
		const deps = buildAcpPanelDepsReadOnly({
			state: mkState({
				sessions: [],
				workers: [mkWorker({ name: "verifier-1", agentName: "pi", status: "streaming", tokenCountTotal: 4321 })],
			}),
			tasks: [],
		});
		const workers = deps.getEntities().filter((e) => e.metadata?.kind === "worker");
		expect(workers).toHaveLength(1);
		expect(workers[0]!.id).toBe("verifier-1");
		expect(workers[0]!.tokens).toBe(4321);
		expect(workers[0]!.status).toBe("streaming");
	});

	it("includes sessions AND workers in the unified list", () => {
		const deps = buildAcpPanelDepsReadOnly({
			state: mkState({
				sessions: [mkSession({ sessionId: "ses_x" })],
				workers: [mkWorker({ name: "wave1" })],
			}),
			tasks: [],
		});
		expect(deps.getEntities()).toHaveLength(2);
	});

	it("passes tasks through unchanged", () => {
		const tasks: AcpPanelTask[] = [
			{ id: "t1", status: "pending" },
			{ id: "t2", status: "in_progress", ownerId: "ses_x" },
		];
		const deps = buildAcpPanelDepsReadOnly({ state: mkState(), tasks });
		expect(deps.getTasks()).toEqual(tasks);
	});

	it("mutation deps throw read-only-slot error", async () => {
		const deps = buildAcpPanelDepsReadOnly({ state: mkState(), tasks: [] });
		await expect(deps.sendMessage("x", "hi")).rejects.toThrow(/read-only/);
		expect(() => deps.abortEntity("x")).toThrow(/read-only/);
		expect(() => deps.killEntity("x")).toThrow(/read-only/);
		await expect(deps.reassignTask("t1", "new")).rejects.toThrow(/read-only/);
		await expect(deps.unassignTask("t1")).rejects.toThrow(/read-only/);
	});

	it("getTranscript returns empty array (read-only)", () => {
		const deps = buildAcpPanelDepsReadOnly({ state: mkState(), tasks: [] });
		expect(deps.getTranscript("any")).toEqual([]);
	});

	it("handles empty state gracefully", () => {
		const deps = buildAcpPanelDepsReadOnly({ state: mkState(), tasks: [] });
		expect(deps.getEntities()).toEqual([]);
		expect(deps.getTasks()).toEqual([]);
	});

	it("entity metadata carries kind=session for sessions", () => {
		const deps = buildAcpPanelDepsReadOnly({
			state: mkState({ sessions: [mkSession({ sessionId: "ses_m" })] }),
			tasks: [],
		});
		const e = deps.getEntities()[0]!;
		expect(e.metadata?.kind).toBe("session");
	});

	it("entity for worker carries currentTaskId when present", () => {
		const deps = buildAcpPanelDepsReadOnly({
			state: mkState({
				workers: [mkWorker({ name: "w1", currentTaskId: "t9" })],
			}),
			tasks: [],
		});
		const e = deps.getEntities().find((x) => x.metadata?.kind === "worker")!;
		expect(e.metadata?.currentTaskId).toBe("t9");
	});
});

// Type-level guard: ensures ReadOnlyPanelSources is exported and shaped.
const _typeCheck: ReadOnlyPanelSources = { state: mkState(), tasks: [] };
void _typeCheck;

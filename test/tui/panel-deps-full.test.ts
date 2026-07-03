/**
 * Tests for src/tui/panel-deps-full.ts — full interactive adapter wiring
 * mutations to source callbacks.
 *
 * RED phase: tests written before the wiring into index.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { buildAcpPanelDepsFull, type FullPanelSources } from "../../src/tui/panel-deps-full.js";
import type { AcpWidgetState } from "../../src/acp-widget.js";
import type { AcpPanelTask, AcpPanelTranscriptEntry } from "../../src/tui/acp-panel.js";

function mkState(over: Partial<AcpWidgetState> = {}): AcpWidgetState {
	return {
		sessions: [{
			sessionId: "ses_1", agentName: "pi", cwd: "/tmp", status: "idle",
			lastActivityAt: new Date(), createdAt: new Date(),
		}],
		circuitBreakerState: "closed",
		configuredAgentNames: ["pi"],
		activity: { activeDelegations: 0, activeBroadcasts: 0, activeCompares: 0, delegations: [] },
		...over,
	};
}

function mkSources(over: Partial<FullPanelSources> = {}): FullPanelSources {
	return {
		getState: () => mkState(),
		getTasks: () => [],
		sendMessage: vi.fn(async () => {}),
		abortEntity: vi.fn(),
		killEntity: vi.fn(),
		reassignTask: vi.fn(async () => true),
		unassignTask: vi.fn(async () => true),
		getTranscript: vi.fn(() => []),
		...over,
	};
}

describe("buildAcpPanelDepsFull", () => {
	it("delegates sendMessage to source", async () => {
		const send = vi.fn(async () => {});
		const deps = buildAcpPanelDepsFull(mkSources({ sendMessage: send }));
		await deps.sendMessage("ses_1", "hi");
		expect(send).toHaveBeenCalledWith("ses_1", "hi");
	});

	it("delegates abortEntity to source", () => {
		const abort = vi.fn();
		const deps = buildAcpPanelDepsFull(mkSources({ abortEntity: abort }));
		deps.abortEntity("ses_1");
		expect(abort).toHaveBeenCalledWith("ses_1");
	});

	it("delegates killEntity to source", () => {
		const kill = vi.fn();
		const deps = buildAcpPanelDepsFull(mkSources({ killEntity: kill }));
		deps.killEntity("w1");
		expect(kill).toHaveBeenCalledWith("w1");
	});

	it("delegates reassignTask to source and returns its result", async () => {
		const reassign = vi.fn(async () => true);
		const deps = buildAcpPanelDepsFull(mkSources({ reassignTask: reassign }));
		const ok = await deps.reassignTask("t1", "ses_2");
		expect(reassign).toHaveBeenCalledWith("t1", "ses_2");
		expect(ok).toBe(true);
	});

	it("delegates unassignTask to source and returns its result", async () => {
		const unassign = vi.fn(async () => false);
		const deps = buildAcpPanelDepsFull(mkSources({ unassignTask: unassign }));
		const ok = await deps.unassignTask("t1");
		expect(unassign).toHaveBeenCalledWith("t1");
		expect(ok).toBe(false);
	});

	it("delegates getTranscript to source", () => {
		const entries: AcpPanelTranscriptEntry[] = [{ timestamp: 1, kind: "text", text: "hi" }];
		const getTranscript = vi.fn(() => entries);
		const deps = buildAcpPanelDepsFull(mkSources({ getTranscript }));
		expect(deps.getTranscript("ses_1")).toBe(entries);
		expect(getTranscript).toHaveBeenCalledWith("ses_1");
	});

	it("maps entities via the read-only adapter (sessions + workers)", () => {
		const deps = buildAcpPanelDepsFull(mkSources({
			getState: () => mkState({
				sessions: [{ sessionId: "s1", agentName: "pi", cwd: "/", status: "active", lastActivityAt: new Date(), createdAt: new Date() }],
				workers: [{ name: "w1", agentName: "pi", status: "idle", tokenCountTotal: 0, toolCallCount: 0, ageSeconds: 1, stale: false }],
			}),
		}));
		const entities = deps.getEntities();
		expect(entities).toHaveLength(2);
		expect(entities.find((e) => e.metadata?.claim === true)?.name).toBe("w1");
	});

	it("passes tasks through", () => {
		const tasks: AcpPanelTask[] = [{ id: "t1", status: "pending" }];
		const deps = buildAcpPanelDepsFull(mkSources({ getTasks: () => tasks }));
		expect(deps.getTasks()).toBe(tasks);
	});

	it("swallows sendMessage errors (best-effort, never throws)", async () => {
		const deps = buildAcpPanelDepsFull(mkSources({
			sendMessage: vi.fn(async () => { throw new Error("boom"); }),
		}));
		await expect(deps.sendMessage("x", "y")).resolves.toBeUndefined();
	});

	it("swallows abortEntity errors", () => {
		const deps = buildAcpPanelDepsFull(mkSources({
			abortEntity: () => { throw new Error("boom"); },
		}));
		expect(() => deps.abortEntity("x")).not.toThrow();
	});

	it("swallows killEntity errors", () => {
		const deps = buildAcpPanelDepsFull(mkSources({
			killEntity: () => { throw new Error("boom"); },
		}));
		expect(() => deps.killEntity("x")).not.toThrow();
	});

	it("reassignTask returns false on source error", async () => {
		const deps = buildAcpPanelDepsFull(mkSources({
			reassignTask: vi.fn(async () => { throw new Error("boom"); }),
		}));
		expect(await deps.reassignTask("t1", "o")).toBe(false);
	});

	it("unassignTask returns false on source error", async () => {
		const deps = buildAcpPanelDepsFull(mkSources({
			unassignTask: vi.fn(async () => { throw new Error("boom"); }),
		}));
		expect(await deps.unassignTask("t1")).toBe(false);
	});
});

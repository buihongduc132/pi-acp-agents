/**
 * RED PHASE (TDD) — Finding P4: Cold-spawn in coordinator.delegateToAgent
 *
 * BUG TO PROVE:
 *   src/coordination/coordinator.ts — delegateToAgent() constructs a fresh
 *   adapter on EVERY invocation (createAdapter called per-call, line ~148),
 *   then spawn() + initialize() + newSession() + prompt() + dispose().
 *
 *   Calling coordinator.delegate('pi', msg) twice creates TWO adapters, TWO
 *   spawns, TWO initializes (~17s cold-start EACH), with NO session reuse.
 *
 * DESIRED BEHAVIOR (what this test asserts):
 *   The SAME agent should reuse a single adapter across consecutive delegate()
 *   calls → spawn/initialize/newSession each called EXACTLY ONCE.
 *
 * CURRENT BEHAVIOR (why this test FAILS):
 *   Each delegate() cold-spawns a new adapter → spawn/initialize/newSession
 *   each called TWICE. The reuse assertions below fail:
 *     expected 1, received 2.
 *
 * This is a RED test: the "reuse" cases are EXPECTED to fail today, proving
 * the P4 cold-spawn defect. The "different agent" sanity case PASSES, proving
 * the test harness is wired correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import type { AcpConfig } from "../../src/config/types.js";

// --- Mock the adapter factory (the cold-spawn seam) ---------------------
const { mockCreateAdapter } = vi.hoisted(() => ({
	mockCreateAdapter: vi.fn(),
}));

vi.mock("../../src/adapter-factory.js", () => ({
	createAdapter: mockCreateAdapter,
}));

// --- A mock adapter whose method invocations we count -------------------
interface MockAdapter {
	spawn: ReturnType<typeof vi.fn>;
	initialize: ReturnType<typeof vi.fn>;
	newSession: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
	connected: boolean;
}

let spawnCount: number;
let initializeCount: number;
let newSessionCount: number;
let promptCount: number;
let disposeCount: number;
let adaptersCreated: MockAdapter[];

function makeMockAdapter(): MockAdapter {
	const adapter: MockAdapter = {
		spawn: vi.fn().mockResolvedValue(undefined),
		initialize: vi.fn().mockResolvedValue(undefined),
		newSession: vi.fn().mockResolvedValue(`session-${adaptersCreated.length + 1}`),
		prompt: vi.fn().mockResolvedValue({
			text: "response",
			stopReason: "end_turn",
			sessionId: `session-${adaptersCreated.length + 1}`,
		}),
		dispose: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn(),
		connected: true,
	};
	adaptersCreated.push(adapter);
	return adapter;
}

const mockConfig: AcpConfig = {
	agent_servers: {
		pi: { command: "echo", args: ["pi"] },
		claude: { command: "echo", args: ["claude"] },
	},
	defaultAgent: "pi",
	stallTimeoutMs: 5000,
};

function resetCounters() {
	spawnCount = 0;
	initializeCount = 0;
	newSessionCount = 0;
	promptCount = 0;
	disposeCount = 0;
	adaptersCreated = [];
	mockCreateAdapter.mockImplementation(() => {
		// Wrap each adapter so we tally lifecycle counts in one place.
		const adapter = makeMockAdapter();
		const wrap = (orig: ReturnType<typeof vi.fn>) =>
			vi.fn(async (...args: unknown[]) => {
				// delegating count is tracked on the original fn via toHaveBeenCalledTimes
				return orig(...args);
			});
		// Count via post-call inspection; simplest is to instrument below.
		void wrap;
		return adapter;
	});
}

/**
 * Tally lifecycle calls across all adapters that were created during a run.
 * Because each cold-spawn builds a NEW adapter, we must sum across adapters.
 */
function tallyLifecycle() {
	spawnCount = adaptersCreated.reduce((n, a) => n + a.spawn.mock.calls.length, 0);
	initializeCount = adaptersCreated.reduce(
		(n, a) => n + a.initialize.mock.calls.length,
		0,
	);
	newSessionCount = adaptersCreated.reduce(
		(n, a) => n + a.newSession.mock.calls.length,
		0,
	);
	promptCount = adaptersCreated.reduce((n, a) => n + a.prompt.mock.calls.length, 0);
	disposeCount = adaptersCreated.reduce(
		(n, a) => n + a.dispose.mock.calls.length,
		0,
	);
}

describe("P4 cold-spawn — coordinator.delegateToAgent adapter reuse (RED)", () => {
	beforeEach(() => {
		resetCounters();
	});

	it("DESIRE (RED): same agent twice MUST reuse one adapter → spawn called ONCE", async () => {
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");

		await coordinator.delegate("pi", "first message");
		await coordinator.delegate("pi", "second message");

		tallyLifecycle();

		// DESIRED: a single adapter reused across both calls.
		expect(adaptersCreated.length).toBe(1); // FAILS: got 2
		expect(spawnCount).toBe(1); // FAILS: cold-spawn calls spawn twice
		expect(initializeCount).toBe(1); // FAILS: initialize twice
		expect(newSessionCount).toBe(1); // FAILS: newSession twice
		expect(promptCount).toBe(2); // both prompts DID run (correct)
	});

	it("DESIRE (RED): initialize + newSession each called ONCE for repeated same-agent delegate", async () => {
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");

		await coordinator.delegate("pi", "msg A");
		await coordinator.delegate("pi", "msg B");
		await coordinator.delegate("pi", "msg C");

		tallyLifecycle();

		// Reusing a warm adapter means spawn/initialize/newSession run once total.
		expect(spawnCount).toBe(1); // FAILS: got 3
		expect(initializeCount).toBe(1); // FAILS: got 3
		expect(newSessionCount).toBe(1); // FAILS: got 3
		expect(promptCount).toBe(3); // correct — every message is prompted
	});

	it("SANITY (GREEN): DIFFERENT agents DO get separate adapters (expect 2 spawns)", async () => {
		// This guards the test harness: we are NOT collapsing distinct agents.
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");

		await coordinator.delegate("pi", "to pi");
		await coordinator.delegate("claude", "to claude");

		tallyLifecycle();

		// Correct behaviour: one adapter per distinct agent.
		expect(adaptersCreated.length).toBe(2);
		expect(spawnCount).toBe(2);
		expect(initializeCount).toBe(2);
		expect(newSessionCount).toBe(2);
		expect(promptCount).toBe(2);
	});
});

/**
 * RED PHASE — Failing tests for Feature 1+2+3
 * (Types + Telemetry + Silent-Failure Detection)
 *
 * These tests MUST FAIL because the implementation doesn't exist yet.
 * They define the expected contract for:
 *   - Extended AcpAsyncRunRecord fields (turns, toolCalls, tokensUsed, lastActivityAt, filesWritten)
 *   - "needs-attention" state in AcpAsyncRunState
 *   - AsyncRunError structured error interface
 *   - Telemetry accumulation after runs
 *   - Silent-failure detection (toolCalls===0 && filesWritten===0 → state "failed")
 *   - Wake notification callback on silent failure
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AcpAsyncRunRecord, AcpAsyncRunState } from "../../src/config/types.js";

// ── Mock session events ──────────────────────────────────────────────

type SessionEventType = "tool_call" | "file_write" | "token_usage" | "turn_end";

interface MockSessionEvent {
	type: SessionEventType;
	payload?: Record<string, unknown>;
}

// Events for a "normal" run: 2 tool calls, 1 file write, 150 tokens, 1 turn
const NORMAL_EVENTS: MockSessionEvent[] = [
	{ type: "tool_call", payload: { name: "write_file" } },
	{ type: "file_write", payload: { path: "src/foo.ts" } },
	{ type: "token_usage", payload: { input: 100, output: 50 } },
	{ type: "turn_end" },
	{ type: "tool_call", payload: { name: "read_file" } },
];

// Events for a silent-failure run: no tool calls, no file writes, empty output
const SILENT_FAILURE_EVENTS: MockSessionEvent[] = [];

// ── Mock factories ───────────────────────────────────────────────────

/**
 * Enhanced mock coordinator that simulates session events during delegation.
 * The delegate method accepts an optional 4th arg `onEvent` callback.
 * Events are emitted sequentially during the simulated delegation.
 */
function createMockCoordinatorWithEvents(
	events: MockSessionEvent[],
	finalResponse: string,
	delayMs = 50,
) {
	return {
		delegate: vi.fn(
			async (
				_agentName: string,
				_message: string,
				_cwd?: string,
				onEvent?: (e: MockSessionEvent) => void,
			) => {
				await new Promise((r) => setTimeout(r, delayMs));
				for (const evt of events) {
					if (typeof onEvent === "function") onEvent(evt);
				}
				return { text: finalResponse, stopReason: "stop" as const, sessionId: "mock-ses-events" };
			},
		),
	};
}

/**
 * Standard mock coordinator (no events). Returns empty text + sessionId.
 * Used for silent-failure scenarios where the agent produces no output.
 */
function createSilentMockCoordinator(delayMs = 50) {
	return {
		delegate: vi.fn(async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return { text: "", stopReason: "stop" as const, sessionId: "mock-ses-empty" };
		}),
	};
}

/**
 * Standard mock coordinator returning meaningful output.
 */
function createNormalMockCoordinator(delayMs = 50) {
	return {
		delegate: vi.fn(async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return {
				text: "Done. Created src/foo.ts and updated config.",
				stopReason: "stop" as const,
				sessionId: "mock-ses-normal",
			};
		}),
	};
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract telemetry fields from a record (cast to any for new fields).
 */
function telemetry(record: AcpAsyncRunRecord | undefined) {
	const r = record as unknown as Record<string, unknown>;
	return {
		turns: r.turns as number | undefined,
		toolCalls: r.toolCalls as number | undefined,
		tokensUsed: r.tokensUsed as number | undefined,
		lastActivityAt: r.lastActivityAt as string | undefined,
		filesWritten: r.filesWritten as number | undefined,
		outputPath: r.outputPath as string | undefined,
		errorDetail: r.errorDetail as { reason: string; message?: string } | undefined,
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "acp-async-telemetry-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// Group 1: Type extensions (AcpAsyncRunRecord new fields)
// ═══════════════════════════════════════════════════════════════════════

describe("Type extensions — AcpAsyncRunRecord new fields", () => {
	it("T1.1: completed run record has telemetry fields populated", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinatorWithEvents(NORMAL_EVENTS, "Done", 50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Write a file");
		await new Promise((r) => setTimeout(r, 300));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();
		expect(record!.state).toBe("completed");

		const t = telemetry(record);
		expect(t.turns).toBeDefined();
		expect(typeof t.turns).toBe("number");
		expect(t.turns!).toBeGreaterThanOrEqual(0);

		expect(t.toolCalls).toBeDefined();
		expect(typeof t.toolCalls).toBe("number");
		expect(t.toolCalls!).toBeGreaterThanOrEqual(0);

		expect(t.tokensUsed).toBeDefined();
		expect(typeof t.tokensUsed).toBe("number");
		expect(t.tokensUsed!).toBeGreaterThanOrEqual(0);

		expect(t.lastActivityAt).toBeDefined();
		expect(typeof t.lastActivityAt).toBe("string");
		// Must be a valid ISO date
		expect(new Date(t.lastActivityAt!).toISOString()).toBe(t.lastActivityAt);

		expect(t.filesWritten).toBeDefined();
		expect(typeof t.filesWritten).toBe("number");
		expect(t.filesWritten!).toBeGreaterThanOrEqual(0);
	});

	it("T1.2: AcpAsyncRunState includes 'needs-attention' as a valid active state", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createNormalMockCoordinator(50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		// Inject a record with state "needs-attention" directly into the file-backed store.
		// The implementation should recognize this as a non-terminal active state.
		const storePath = join(tmpDir, "async-runs.json");
		const injected = {
			runId: "needs-att-1",
			agentName: "gemini",
			message: "Waiting for human review",
			state: "needs-attention",
			createdAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
		};
		writeFileSync(storePath, JSON.stringify({ runs: [injected] }));

		// listActive() should include runs in "needs-attention" state
		const active = executor.listActive();
		const found = active.find((r) => (r.state as string) === "needs-attention");
		expect(found).toBeDefined();
		expect(found!.runId).toBe("needs-att-1");

		// Also verify the type union accepts "needs-attention" at runtime
		const validStates: string[] = ["pending", "running", "completed", "failed", "needs-attention"];
		const state: AcpAsyncRunState = "needs-attention" as AcpAsyncRunState;
		expect(validStates).toContain(state);
	});

	it("T1.3: AsyncRunError interface — failed run has structured error with reason", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = {
			delegate: vi.fn(async () => {
				throw new Error("Rate limit exceeded");
			}),
		};
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Do something");
		await new Promise((r) => setTimeout(r, 200));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();
		expect(record!.state).toBe("failed");

		// The record should have a structured errorDetail field
		const t = telemetry(record);
		expect(t.errorDetail).toBeDefined();
		expect(t.errorDetail).toHaveProperty("reason");

		// The reason must be one of the valid AsyncRunError reasons
		const validReasons = ["silent-no-output", "rate-limit", "crash", "unknown"];
		expect(validReasons).toContain(t.errorDetail!.reason);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Group 2: Telemetry accumulation
// ═══════════════════════════════════════════════════════════════════════

describe("Telemetry accumulation", () => {
	it("T2.1: getStatus returns record with telemetry fields after completion", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinatorWithEvents(NORMAL_EVENTS, "Done", 50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Write a file");
		await new Promise((r) => setTimeout(r, 300));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();

		const t = telemetry(record);
		// All telemetry fields must be populated
		expect(t.turns).toBeDefined();
		expect(t.toolCalls).toBeDefined();
		expect(t.tokensUsed).toBeDefined();
		expect(t.lastActivityAt).toBeDefined();
		expect(t.filesWritten).toBeDefined();

		// Specific expected values from NORMAL_EVENTS
		expect(t.toolCalls).toBe(2); // 2 tool_call events
		expect(t.filesWritten).toBe(1); // 1 file_write event
		expect(t.tokensUsed).toBe(150); // 100 input + 50 output
		expect(t.turns).toBe(1); // 1 turn_end event
	});

	it("T2.2: listActive returns runs sorted by lastActivityAt descending", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		// Use longer delay to ensure distinct lastActivityAt timestamps
		const coordinator = createMockCoordinatorWithEvents(NORMAL_EVENTS, "Done", 100);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		// Start multiple runs with staggered timing
		executor.start("gemini", "Task 1");
		await new Promise((r) => setTimeout(r, 150));
		executor.start("codex", "Task 2");
		await new Promise((r) => setTimeout(r, 150));
		executor.start("pi", "Task 3");

		// Wait for all to complete
		await new Promise((r) => setTimeout(r, 400));

		// listActive should return runs sorted by lastActivityAt descending
		// (most recent activity first)
		// Since all completed, listActive returns empty. We test listAll instead
		// — but the spec says listActive. For active runs, they should be sorted.
		// Let's test with runs still in progress:
		const slowCoordinator = createMockCoordinatorWithEvents(NORMAL_EVENTS, "Done", 2000);
		const slowExecutor = new AsyncExecutor(slowCoordinator as any, tmpDir);

		slowExecutor.start("gemini", "Slow 1");
		await new Promise((r) => setTimeout(r, 50));
		slowExecutor.start("codex", "Slow 2");
		await new Promise((r) => setTimeout(r, 50));
		slowExecutor.start("pi", "Slow 3");

		const active = slowExecutor.listActive();
		expect(active.length).toBeGreaterThanOrEqual(2);

		// Verify descending sort by lastActivityAt
		for (let i = 0; i < active.length - 1; i++) {
			const current = telemetry(active[i]).lastActivityAt;
			const next = telemetry(active[i + 1]).lastActivityAt;
			expect(current).toBeDefined();
			expect(next).toBeDefined();
			expect(new Date(current!).getTime()).toBeGreaterThanOrEqual(
				new Date(next!).getTime(),
			);
		}
	});

	it("T2.3: outputPath field is set on the run record when provided", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createNormalMockCoordinator(50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir) as any;

		const outputPath = join(tmpDir, "output.txt");
		const runId = executor.start("gemini", "Write output", undefined, { outputPath });
		await new Promise((r) => setTimeout(r, 200));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();

		const t = telemetry(record);
		expect(t.outputPath).toBe(outputPath);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Group 3: Silent-failure detection
// ═══════════════════════════════════════════════════════════════════════

describe("Silent-failure detection", () => {
	it("T3.1: silent failure (toolCalls===0 && filesWritten===0) → state 'failed' with error 'silent-no-output'", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		// Mock that returns empty text with zero tool calls
		const coordinator = createSilentMockCoordinator(50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Do something important");
		await new Promise((r) => setTimeout(r, 300));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();

		// Silent failure should override state to "failed"
		expect(record!.state).toBe("failed");

		// Error should contain "silent-no-output"
		expect(record!.error).toBeDefined();
		expect(record!.error).toContain("silent-no-output");
	});

	it("T3.2: normal run (toolCalls>0 || filesWritten>0) → state remains 'completed'", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinatorWithEvents(NORMAL_EVENTS, "Done. Created files.", 50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Write a file");
		await new Promise((r) => setTimeout(r, 300));

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();

		// Telemetry should show activity
		const t = telemetry(record);
		expect(t.toolCalls).toBeDefined();
		expect(t.toolCalls!).toBeGreaterThan(0);

		// State should be "completed" (not overridden to "failed")
		expect(record!.state).toBe("completed");
		expect(record!.error).toBeUndefined();
	});

	it("T3.3: silent failure emits a wake notification via callback", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const wakeSpy = vi.fn();
		const coordinator = createSilentMockCoordinator(50);

		// Pass wake notification callback via constructor options
		const ExecutorCtor = AsyncExecutor as any;
		const executor = new ExecutorCtor(coordinator, tmpDir, {
			onWakeNotification: wakeSpy,
		});

		const runId = executor.start("gemini", "Do something important");
		await new Promise((r) => setTimeout(r, 300));

		// Verify the run actually failed silently
		const record = executor.getStatus(runId);
		expect(record).toBeDefined();
		expect(record!.state).toBe("failed");

		// The wake notification callback should have been invoked
		expect(wakeSpy).toHaveBeenCalled();

		// Verify the callback received the runId and reason
		const callArgs = wakeSpy.mock.calls[0];
		expect(callArgs).toBeDefined();
		expect(callArgs[0]).toBe(runId); // first arg: runId
		expect(callArgs[1]).toBeDefined(); // second arg: notification info
		expect(callArgs[1].reason).toBe("silent-no-output");
	});
});

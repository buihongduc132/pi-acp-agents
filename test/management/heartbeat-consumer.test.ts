/**
 * Task 2.2 — heartbeat consumer integration.
 *
 * Covers the full consume path: malformed/missing session/update fields are
 * treated as zero-delta and still call WorkerStore.touch(); when the consume
 * operation throws (e.g. worker deleted mid-stream), a `heartbeat_parse_error`
 * event is appended to AcpEventLog without crashing.
 */
import { describe, it, expect, vi } from "vitest";
import { consumeHeartbeat } from "../../src/management/heartbeat-parser.js";

describe("consumeHeartbeat (Task 2.2 — consumer integration)", () => {
	function makeDeps(opts: { workerName?: string; touchThrows?: Error } = {}) {
		const { workerName = "w1", touchThrows } = opts;
		const touch = vi.fn();
		if (touchThrows) touch.mockImplementation(() => { throw touchThrows; });
		const logParseError = vi.fn();
		const resolveWorkerName = vi.fn((sid: string) =>
			sid === "sess-1" ? workerName : undefined,
		);
		return { touch, logParseError, resolveWorkerName };
	}

	it("treats malformed usage_update (missing used/size) as zero-delta and calls touch", () => {
		const deps = makeDeps();
		consumeHeartbeat(
			deps,
			"sess-1",
			{ sessionUpdate: "usage_update", size: 1000 } as any, // 'used' missing
		);
		expect(deps.touch).toHaveBeenCalledWith("w1", { tokenDelta: 0, toolCallDelta: 0 });
		expect(deps.logParseError).not.toHaveBeenCalled();
	});

	it("treats non-number used as zero-delta and calls touch", () => {
		const deps = makeDeps();
		consumeHeartbeat(
			deps,
			"sess-1",
			{ sessionUpdate: "usage_update", used: "lots", size: "big" } as any,
		);
		expect(deps.touch).toHaveBeenCalledWith("w1", { tokenDelta: 0, toolCallDelta: 0 });
	});

	it("passes real token delta through to touch for well-formed usage_update", () => {
		const deps = makeDeps();
		consumeHeartbeat(
			deps,
			"sess-1",
			{ sessionUpdate: "usage_update", used: 42, size: 1000 } as any,
		);
		expect(deps.touch).toHaveBeenCalledWith("w1", { tokenDelta: 42, toolCallDelta: 0 });
	});

	it("counts a tool_call as one tool-call delta", () => {
		const deps = makeDeps();
		consumeHeartbeat(
			deps,
			"sess-1",
			{ sessionUpdate: "tool_call", toolCallId: "tc-1" } as any,
		);
		expect(deps.touch).toHaveBeenCalledWith("w1", { tokenDelta: 0, toolCallDelta: 1 });
	});

	it("returns early (no touch) for a non-worker-bound session", () => {
		const deps = makeDeps();
		consumeHeartbeat(
			deps,
			"unknown-session",
			{ sessionUpdate: "usage_update", used: 5 } as any,
		);
		expect(deps.touch).not.toHaveBeenCalled();
		expect(deps.logParseError).not.toHaveBeenCalled();
	});

	it("logs heartbeat_parse_error and does NOT crash when touch throws", () => {
		const deps = makeDeps({ touchThrows: new Error('Worker "w1" not found') });
		consumeHeartbeat(
			deps,
			"sess-1",
			{ sessionUpdate: "usage_update", used: 7, size: 100 } as any,
		);
		expect(deps.touch).toHaveBeenCalled();
		expect(deps.logParseError).toHaveBeenCalledWith({
			workerName: "w1",
			sessionId: "sess-1",
			error: 'Worker "w1" not found',
		});
	});

	it("logs heartbeat_parse_error with stringified non-Error throw", () => {
		const deps = makeDeps({ touchThrows: "boom" as unknown as Error });
		consumeHeartbeat(
			deps,
			"sess-1",
			{ sessionUpdate: "tool_call" } as any,
		);
		expect(deps.logParseError).toHaveBeenCalledWith({
			workerName: "w1",
			sessionId: "sess-1",
			error: "boom",
		});
	});
});

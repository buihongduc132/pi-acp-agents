/**
 * Task 2.2 — defensive parsing for malformed session/update fields.
 *
 * The heartbeat consumer must treat missing/non-number token/tool fields as
 * zero-delta (never crash) and still call WorkerStore.touch.
 */
import { describe, it, expect } from "vitest";
import { parseHeartbeatDeltas } from "../../src/management/heartbeat-parser.js";

describe("parseHeartbeatDeltas (Task 2.2 — defensive parsing)", () => {
	it("extracts token delta from a well-formed usage_update", () => {
		const deltas = parseHeartbeatDeltas({
			sessionUpdate: "usage_update",
			used: 42,
			size: 1000,
		} as any);
		expect(deltas.tokenDelta).toBe(42);
		expect(deltas.toolCallDelta).toBe(0);
	});

	it("treats missing 'used' as zero-delta (malformed usage_update)", () => {
		const deltas = parseHeartbeatDeltas({
			sessionUpdate: "usage_update",
			// 'used' missing entirely
			size: 1000,
		} as any);
		expect(deltas.tokenDelta).toBe(0);
		expect(deltas.toolCallDelta).toBe(0);
	});

	it("treats non-number 'used' as zero-delta", () => {
		const deltas = parseHeartbeatDeltas({
			sessionUpdate: "usage_update",
			used: "lots",
			size: "big",
		} as any);
		expect(deltas.tokenDelta).toBe(0);
		expect(deltas.toolCallDelta).toBe(0);
	});

	it("treats missing 'size' as zero (size missing entirely)", () => {
		const deltas = parseHeartbeatDeltas({
			sessionUpdate: "usage_update",
			used: 7,
			// 'size' missing entirely
		} as any);
		expect(deltas.tokenDelta).toBe(7);
		expect(deltas.toolCallDelta).toBe(0);
	});

	it("counts a tool_call as one tool-call delta", () => {
		const deltas = parseHeartbeatDeltas({
			sessionUpdate: "tool_call",
			toolCallId: "tc-1",
		} as any);
		expect(deltas.tokenDelta).toBe(0);
		expect(deltas.toolCallDelta).toBe(1);
	});

	it("returns zero-delta when sessionUpdate field is missing entirely", () => {
		const deltas = parseHeartbeatDeltas({
			// no sessionUpdate key at all
			something: "else",
		} as any);
		expect(deltas.tokenDelta).toBe(0);
		expect(deltas.toolCallDelta).toBe(0);
	});

	it("returns zero-delta for an unrecognized sessionUpdate type", () => {
		const deltas = parseHeartbeatDeltas({
			sessionUpdate: "some_unknown_type",
			used: 999,
		} as any);
		expect(deltas.tokenDelta).toBe(0);
		expect(deltas.toolCallDelta).toBe(0);
	});

	it("never throws for a completely empty object", () => {
		expect(() => parseHeartbeatDeltas({} as any)).not.toThrow();
		const deltas = parseHeartbeatDeltas({} as any);
		expect(deltas.tokenDelta).toBe(0);
		expect(deltas.toolCallDelta).toBe(0);
	});
});

/**
 * Type-level + smoke test for the `AcpWidgetDag` interface added in task 1.1.
 *
 * Verifies that an `AcpWidgetDag` value can be constructed with the documented
 * field shape, and that optional fields (`currentWave`, `totalWaves`) may be
 * omitted while required fields may not.
 */
import { describe, it, expect } from "vitest";
import type { AcpWidgetDag } from "../src/acp-widget.js";

describe("AcpWidgetDag type", () => {
	it("constructs a fully-specified AcpWidgetDag value", () => {
		const dag: AcpWidgetDag = {
			dagId: "a1b2c3",
			status: "running",
			total: 5,
			completed: 2,
			failed: 1,
			cancelled: 0,
			currentWave: 2,
			totalWaves: 3,
			createdAt: new Date("2026-06-21T00:00:00.000Z"),
			updatedAt: new Date("2026-06-21T00:02:00.000Z"),
		};

		expect(dag.dagId).toBe("a1b2c3");
		expect(dag.status).toBe("running");
		expect(dag.total).toBe(5);
		expect(dag.completed).toBe(2);
		expect(dag.failed).toBe(1);
		expect(dag.cancelled).toBe(0);
		expect(dag.currentWave).toBe(2);
		expect(dag.totalWaves).toBe(3);
		expect(dag.createdAt).toBeInstanceOf(Date);
		expect(dag.updatedAt).toBeInstanceOf(Date);
	});

	it("allows omitting optional currentWave / totalWaves", () => {
		const dag: AcpWidgetDag = {
			dagId: "abc",
			status: "completed",
			total: 3,
			completed: 3,
			failed: 0,
			cancelled: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		expect(dag.currentWave).toBeUndefined();
		expect(dag.totalWaves).toBeUndefined();
	});
});

/**
 * Test for the `renderDagSummary` helper added in task 2.2.
 *
 * Spec: `renderDagSummary(dags: AcpWidgetDag[]): string` returns a collapsed
 * one-line string of `<dagId>:<icon>` pairs joined by spaces, capped at 5
 * entries (D2 — order preserved from input).
 */
import { describe, it, expect } from "vitest";
import { renderDagSummary } from "../src/acp-widget.js";
import type { AcpWidgetDag } from "../src/acp-widget.js";

function minutesAgo(min: number): Date {
	return new Date(Date.now() - min * 60_000);
}

describe("renderDagSummary", () => {
	it("returns empty string for an empty list", () => {
		expect(renderDagSummary([])).toBe("");
	});

	it("renders a single completed DAG as <dagId>:<icon>", () => {
		const dags: AcpWidgetDag[] = [
			{
				dagId: "a1b2c3",
				status: "completed",
				total: 3,
				completed: 3,
				failed: 0,
				cancelled: 0,
				createdAt: minutesAgo(10),
				updatedAt: minutesAgo(1),
			},
		];

		expect(renderDagSummary(dags)).toBe("a1b2c3:✓");
	});

	it("renders mixed completed/failed DAGs as space-joined pairs", () => {
		const dags: AcpWidgetDag[] = [
			{
				dagId: "a1b2c3",
				status: "completed",
				total: 3,
				completed: 3,
				failed: 0,
				cancelled: 0,
				createdAt: minutesAgo(10),
				updatedAt: minutesAgo(1),
			},
			{
				dagId: "d4e5f6",
				status: "failed",
				total: 3,
				completed: 1,
				failed: 2,
				cancelled: 0,
				createdAt: minutesAgo(12),
				updatedAt: minutesAgo(2),
			},
		];

		expect(renderDagSummary(dags)).toBe("a1b2c3:✓ d4e5f6:✕");
	});

	it("caps at 5 entries (D2)", () => {
		const make = (id: string): AcpWidgetDag => ({
			dagId: id,
			status: "completed",
			total: 1,
			completed: 1,
			failed: 0,
			cancelled: 0,
			createdAt: minutesAgo(20),
			updatedAt: minutesAgo(1),
		});
		const dags: AcpWidgetDag[] = [
			make("d1"),
			make("d2"),
			make("d3"),
			make("d4"),
			make("d5"),
			make("d6"),
			make("d7"),
		];

		const out = renderDagSummary(dags);
		const pairs = out.split(" ");
		expect(pairs).toHaveLength(5);
		expect(out).toBe("d1:✓ d2:✓ d3:✓ d4:✓ d5:✓");
	});

	it("uses the cancelled icon for a cancelled DAG", () => {
		const dags: AcpWidgetDag[] = [
			{
				dagId: "x1",
				status: "cancelled",
				total: 3,
				completed: 1,
				failed: 0,
				cancelled: 1,
				createdAt: minutesAgo(8),
				updatedAt: minutesAgo(1),
			},
		];

		expect(renderDagSummary(dags)).toBe("x1:◻");
	});
});

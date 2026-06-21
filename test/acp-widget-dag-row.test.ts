/**
 * Test for the `renderDagRow` helper added in task 2.1.
 *
 * Spec: `renderDagRow(dag: AcpWidgetDag): string` returns a single-line string
 * in the format: `<icon> <dagId> <progress> wave <w>/<totalW> <age> [fail:<failed>]`
 *  - omit the `wave <w>/<totalW>` segment when `totalWaves` is absent
 *  - omit the `[fail:<failed>]` segment when `failed === 0`
 */
import { describe, it, expect } from "vitest";
import { renderDagRow } from "../src/acp-widget.js";
import type { AcpWidgetDag } from "../src/acp-widget.js";

function minutesAgo(min: number): Date {
	return new Date(Date.now() - min * 60_000);
}

describe("renderDagRow", () => {
	it("renders a running DAG with wave info and failure marker", () => {
		const dag: AcpWidgetDag = {
			dagId: "a1b2c3",
			status: "running",
			total: 5,
			completed: 2,
			failed: 1,
			cancelled: 0,
			currentWave: 2,
			totalWaves: 3,
			createdAt: minutesAgo(3),
			updatedAt: minutesAgo(2),
		};

		const out = renderDagRow(dag);
		// <icon> <dagId> <progress> wave <w>/<totalW> <age> [fail:<failed>]
		// formatProgress fills completed+failed blocks: 2+1=3 filled
		expect(out).toBe(`● a1b2c3 [███░░] 2/5 wave 2/3 2m ago [fail:1]`);
	});

	it("omits wave segment when totalWaves is absent", () => {
		const dag: AcpWidgetDag = {
			dagId: "abc",
			status: "running",
			total: 4,
			completed: 1,
			failed: 0,
			cancelled: 0,
			createdAt: minutesAgo(1),
			updatedAt: minutesAgo(1),
		};

		const out = renderDagRow(dag);
		// No wave segment; no [fail:0] since failed === 0
		expect(out).toBe(`● abc [█░░░] 1/4 1m ago`);
	});

	it("omits [fail:N] segment when failed === 0", () => {
		const dag: AcpWidgetDag = {
			dagId: "d4e5f6",
			status: "running",
			total: 3,
			completed: 2,
			failed: 0,
			cancelled: 0,
			currentWave: 1,
			totalWaves: 2,
			createdAt: minutesAgo(5),
			updatedAt: minutesAgo(5),
		};

		const out = renderDagRow(dag);
		expect(out).toBe(`● d4e5f6 [██░] 2/3 wave 1/2 5m ago`);
	});

	it("uses the completed status icon for a completed DAG", () => {
		const dag: AcpWidgetDag = {
			dagId: "z9",
			status: "completed",
			total: 3,
			completed: 3,
			failed: 0,
			cancelled: 0,
			createdAt: minutesAgo(10),
			updatedAt: minutesAgo(10),
		};

		const out = renderDagRow(dag);
		expect(out).toBe(`✓ z9 [███] 3/3 10m ago`);
	});

	it("uses the failed status icon for a failed DAG", () => {
		const dag: AcpWidgetDag = {
			dagId: "f1",
			status: "failed",
			total: 3,
			completed: 1,
			failed: 2,
			cancelled: 0,
			createdAt: minutesAgo(10),
			updatedAt: minutesAgo(10),
		};

		const out = renderDagRow(dag);
		expect(out).toBe(`✕ f1 [███] 1/3 10m ago [fail:2]`);
	});
});

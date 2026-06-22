/**
 * Task 3.4 — Verify `DagIndexEntry` shape matches `AcpWidgetDag` mapping.
 *
 * Behavior under test: the pure mapper `dagIndexEntryToWidgetDag(entry)` SHALL
 * remap `DagIndexEntry` fields to `AcpWidgetDag` fields exactly as documented
 * in design.md D1 + task 3.4:
 *
 *   DagIndexEntry     → AcpWidgetDag
 *   ─────────────────────────────────────
 *   dagId             → dagId            (same)
 *   status            → status           (same)
 *   totalSteps        → total            (RENAMED)
 *   completedSteps    → completed        (RENAMED)
 *   failedSteps       → failed           (RENAMED)
 *   (not carried)     → cancelled        (always 0 — index has no cancelled count)
 *   (not carried)     → currentWave      (undefined — index has no wave info)
 *   (not carried)     → totalWaves       (undefined — index has no wave info)
 *   createdAt:string  → createdAt:Date   (parsed)
 *   updatedAt:string  → updatedAt:Date   (parsed)
 */
import { describe, it, expect } from "vitest";
import { dagIndexEntryToWidgetDag } from "../src/acp-widget.js";
import type { AcpWidgetDag } from "../src/acp-widget.js";
import type { DagIndexEntry } from "../src/config/types.js";

function entry(overrides: Partial<DagIndexEntry> = {}): DagIndexEntry {
	return {
		dagId: "dag-1",
		status: "running",
		totalSteps: 7,
		completedSteps: 4,
		failedSteps: 2,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:05:00.000Z",
		...overrides,
	};
}

describe("dagIndexEntryToWidgetDag — task 3.4 (shape verification)", () => {
	it("is a pure exported function", () => {
		expect(typeof dagIndexEntryToWidgetDag).toBe("function");
	});

	it("preserves dagId and status without renaming", () => {
		const out = dagIndexEntryToWidgetDag(entry({ dagId: "abc", status: "running" }));
		expect(out.dagId).toBe("abc");
		expect(out.status).toBe("running");
	});

	it("remaps totalSteps → total", () => {
		const out = dagIndexEntryToWidgetDag(entry({ totalSteps: 7 }));
		expect(out.total).toBe(7);
	});

	it("remaps completedSteps → completed", () => {
		const out = dagIndexEntryToWidgetDag(entry({ completedSteps: 4 }));
		expect(out.completed).toBe(4);
	});

	it("remaps failedSteps → failed", () => {
		const out = dagIndexEntryToWidgetDag(entry({ failedSteps: 2 }));
		expect(out.failed).toBe(2);
	});

	it("defaults cancelled to 0 (DagIndexEntry carries no cancelled count)", () => {
		const out = dagIndexEntryToWidgetDag(entry());
		expect(out.cancelled).toBe(0);
	});

	it("parses ISO createdAt string into a Date", () => {
		const out = dagIndexEntryToWidgetDag(
			entry({ createdAt: "2026-02-03T04:05:06.000Z" }),
		);
		expect(out.createdAt).toEqual(new Date("2026-02-03T04:05:06.000Z"));
		expect(out.createdAt instanceof Date).toBe(true);
	});

	it("parses ISO updatedAt string into a Date", () => {
		const out = dagIndexEntryToWidgetDag(
			entry({ updatedAt: "2026-02-03T07:08:09.000Z" }),
		);
		expect(out.updatedAt).toEqual(new Date("2026-02-03T07:08:09.000Z"));
		expect(out.updatedAt instanceof Date).toBe(true);
	});

	it("leaves currentWave/totalWaves undefined (index carries no wave info)", () => {
		const out = dagIndexEntryToWidgetDag(entry());
		expect(out.currentWave).toBeUndefined();
		expect(out.totalWaves).toBeUndefined();
	});

	it("produces a value assignable to AcpWidgetDag (full contract)", () => {
		const out: AcpWidgetDag = dagIndexEntryToWidgetDag(
			entry({
				dagId: "full",
				status: "failed",
				totalSteps: 5,
				completedSteps: 3,
				failedSteps: 1,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:10:00.000Z",
			}),
		);
		expect(out).toEqual({
			dagId: "full",
			status: "failed",
			total: 5,
			completed: 3,
			failed: 1,
			cancelled: 0,
			currentWave: undefined,
			totalWaves: undefined,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:10:00.000Z"),
		});
	});
});

/**
 * Test for the `formatProgress` helper added in task 1.4.
 *
 * Spec: `formatProgress(completed: number, failed: number, total: number): string`
 * returns e.g. `[██░░░] 2/5` where filled blocks = completed + failed, empty
 * blocks = remaining, bar width = min(total, 8). Edge case `total === 0`
 * returns an empty string.
 */
import { describe, it, expect } from "vitest";
import { formatProgress } from "../src/acp-widget.js";

describe("formatProgress", () => {
	it("renders completed progress with no failures", () => {
		// completed=2, failed=0, total=5 → 2 filled, 3 empty → width min(5,8)=5
		expect(formatProgress(2, 0, 5)).toBe(`[██░░░] 2/5`);
	});

	it("renders all empty at 0 progress", () => {
		expect(formatProgress(0, 0, 5)).toBe(`[░░░░░] 0/5`);
	});

	it("renders fully complete at 5/5", () => {
		expect(formatProgress(5, 0, 5)).toBe(`[█████] 5/5`);
	});

	it("includes failed blocks in filled count", () => {
		// completed=3, failed=1, total=7 → filled=4, empty=3, width=min(7,8)=7
		expect(formatProgress(3, 1, 7)).toBe(`[████░░░] 3/7`);
	});

	it("returns an empty string when total is 0", () => {
		expect(formatProgress(0, 0, 0)).toBe("");
	});

	it("caps the bar width at 8 when total exceeds 8", () => {
		// completed=4, failed=0, total=10 → width=min(10,8)=8, filled=4, empty=4
		expect(formatProgress(4, 0, 10)).toBe(`[████░░░░] 4/10`);
	});
});

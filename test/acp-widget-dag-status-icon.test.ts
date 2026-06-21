/**
 * Test for the `DAG_STATUS_ICON` map added in task 1.3.
 *
 * Verifies the map covers every `DagStatus` value and reuses the existing
 * widget palette (`success`/`warning`/`error`/`muted`/`dim`/`accent`) with the
 * documented icon glyphs.
 */
import { describe, it, expect } from "vitest";
import { DAG_STATUS_ICON } from "../src/acp-widget.js";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type { DagStatus } from "../src/acp-widget.js";

const ALLOWED_COLORS: ThemeColor[] = [
	"success",
	"warning",
	"error",
	"muted",
	"dim",
	"accent",
];

describe("DAG_STATUS_ICON", () => {
	it("covers every DagStatus value", () => {
		const expected: Array<
			"pending" | "running" | "completed" | "failed" | "cancelled" | "stale"
		> = ["pending", "running", "completed", "failed", "cancelled", "stale"];
		for (const status of expected) {
			expect(DAG_STATUS_ICON[status], `missing entry for ${status}`).toBeDefined();
		}
	});

	it("uses the documented icons", () => {
		expect(DAG_STATUS_ICON.running.icon).toBe("●");
		expect(DAG_STATUS_ICON.running.color).toBe("accent");
		expect(DAG_STATUS_ICON.completed.icon).toBe("✓");
		expect(DAG_STATUS_ICON.completed.color).toBe("success");
		expect(DAG_STATUS_ICON.failed.icon).toBe("✕");
		expect(DAG_STATUS_ICON.failed.color).toBe("error");
		expect(DAG_STATUS_ICON.cancelled.icon).toBe("◻");
		expect(DAG_STATUS_ICON.cancelled.color).toBe("dim");
		expect(DAG_STATUS_ICON.pending.icon).toBe("·");
		expect(DAG_STATUS_ICON.pending.color).toBe("muted");
		expect(DAG_STATUS_ICON.stale.icon).toBe("◻");
		expect(DAG_STATUS_ICON.stale.color).toBe("warning");
	});

	it("only uses palette colors from the existing widget palette", () => {
		for (const key of Object.keys(DAG_STATUS_ICON) as DagStatus[]) {
			expect(
				ALLOWED_COLORS,
				`unexpected color ${DAG_STATUS_ICON[key].color} for ${key}`,
			).toContain(DAG_STATUS_ICON[key].color);
		}
	});

	it("every entry has a non-empty single-rune icon string", () => {
		for (const key of Object.keys(DAG_STATUS_ICON) as DagStatus[]) {
			const icon = DAG_STATUS_ICON[key].icon;
			expect(typeof icon, `icon for ${key} must be a string`).toBe("string");
			expect(icon.length, `icon for ${key} must be non-empty`).toBeGreaterThan(0);
		}
	});
});

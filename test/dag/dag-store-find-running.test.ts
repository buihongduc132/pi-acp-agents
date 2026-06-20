import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";
import type {
	DagRecord,
	DagTaskDefinition,
} from "../../src/config/types.js";

/**
 * Task 2.7: Implement `findRunning()` — scans DAG files for DAGs in
 * `running` state (for resume on restart).
 *
 * Per dag-resume spec: "When pi restarts and the DAG extension loads, the
 * system SHALL scan `~/.pi/acp-agents/dag/` for DAGs in `running` state."
 * And: "Stale DAGs SHALL NOT auto-resume". Since `stale` is a distinct
 * status from `running`, a simple `status === "running"` filter naturally
 * excludes stale DAGs. findRunning is a pure disk scan over the per-DAG
 * JSON files and MUST NOT rely on in-memory state (it is the entry point
 * for resume after a fresh process start where no in-memory state exists).
 */
describe("DagStore#findRunning (task 2.7)", () => {
	let tmpDir: string;
	let dagDir: string;
	let dagIndexFile: string;
	let store: DagStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-find-running-"));
		dagDir = join(tmpDir, "dag");
		dagIndexFile = join(dagDir, "dag-index.json");
		store = new DagStore({ dagDir, dagIndexFile });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const linear: DagTaskDefinition[] = [
		{ id: "a", agent: "gemini", prompt: "Research X" },
		{ id: "b", agent: "codex", prompt: "Code", dependsOn: ["a"] },
	];

	it("exposes a findRunning method on DagStore", () => {
		expect(typeof store.findRunning).toBe("function");
	});

	it("returns an empty array when no DAGs exist (directory empty)", () => {
		expect(store.findRunning()).toEqual([]);
	});

	it("returns an empty array when only pending/completed DAGs exist", () => {
		const pending = store.create({ tasks: linear });
		const completed = store.create({ tasks: linear });
		store.updateDagStatus(completed.dagId, "completed");
		// Ensure nothing is running.
		expect(store.findRunning()).toEqual([]);
		// Sanity: pending and completed DAGs are still on disk.
		expect(store.get(pending.dagId)?.status).toBe("pending");
		expect(store.get(completed.dagId)?.status).toBe("completed");
	});

	it("returns the full DagRecord for a single running DAG", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");

		const running = store.findRunning();
		expect(running).toHaveLength(1);
		expect(running[0]!.dagId).toBe(created.dagId);
		expect(running[0]!.status).toBe("running");
		// Returns a full record (not just an ID) so the executor can resume
		// from persisted step states.
		expect(running[0]!.tasks).toEqual(linear);
		expect(running[0]!.steps).toBeDefined();
		expect(Object.keys(running[0]!.steps).sort()).toEqual(["a", "b"]);
	});

	it("returns every running DAG when multiple are running", () => {
		const r1 = store.create({ tasks: linear });
		const r2 = store.create({ tasks: linear });
		const r3 = store.create({ tasks: linear });
		store.updateDagStatus(r1.dagId, "running");
		store.updateDagStatus(r2.dagId, "running");
		store.updateDagStatus(r3.dagId, "running");

		const running = store.findRunning();
		expect(running).toHaveLength(3);
		const ids = running.map((r) => r.dagId).sort();
		expect(ids).toEqual([r1.dagId, r2.dagId, r3.dagId].sort());
		for (const rec of running) {
			expect(rec.status).toBe("running");
		}
	});

	it("excludes DAGs in `stale` state (stale DAGs must not auto-resume)", () => {
		const running = store.create({ tasks: linear });
		const stale = store.create({ tasks: linear });
		store.updateDagStatus(running.dagId, "running");
		store.updateDagStatus(stale.dagId, "stale");

		const found = store.findRunning();
		expect(found).toHaveLength(1);
		expect(found[0]!.dagId).toBe(running.dagId);
	});

	it("excludes DAGs in failed / cancelled terminal states", () => {
		const running = store.create({ tasks: linear });
		const failed = store.create({ tasks: linear });
		const cancelled = store.create({ tasks: linear });
		store.updateDagStatus(running.dagId, "running");
		store.updateDagStatus(failed.dagId, "failed");
		store.updateDagStatus(cancelled.dagId, "cancelled");

		const found = store.findRunning();
		expect(found).toHaveLength(1);
		expect(found[0]!.dagId).toBe(running.dagId);
	});

	it("ignores the dag-index.json summary file when scanning", () => {
		// dag-index.json lives in the same directory as <dagId>.json files
		// but is NOT a DagRecord. It must be skipped during the scan.
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");

		const found = store.findRunning();
		expect(found).toHaveLength(1);
		expect(found[0]!.dagId).toBe(created.dagId);
		// No element should be the index file (index has no `tasks` array
		// and would be an array of summaries, not a record).
		expect(found.every((r) => Array.isArray(r.tasks))).toBe(true);
	});

	it("skips malformed JSON files without throwing", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");
		// Drop a corrupt file alongside the valid one.
		writeFileSync(join(dagDir, "corrupt-dag.json"), "{not valid json", "utf-8");

		const found = store.findRunning();
		expect(found).toHaveLength(1);
		expect(found[0]!.dagId).toBe(created.dagId);
	});

	it("skips non-DagRecord JSON files (parsed but missing required fields) without throwing", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");
		// A well-formed JSON object that is NOT a DagRecord (e.g. a stray
		// config dump). findRunning must not crash on it.
		writeFileSync(
			join(dagDir, "stray.json"),
			JSON.stringify({ hello: "world" }),
			"utf-8",
		);

		const found = store.findRunning();
		expect(found).toHaveLength(1);
		expect(found[0]!.dagId).toBe(created.dagId);
	});

	it("returns running DAGs even when dag-index.json is missing", () => {
		// Simulate resume after a fresh process start where the index may
		// be out of sync or absent — findRunning must scan per-DAG files
		// directly, not consult the index.
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");
		// Wipe the index entirely.
		rmSync(dagIndexFile, { force: true });

		const found = store.findRunning();
		expect(found).toHaveLength(1);
		expect(found[0]!.dagId).toBe(created.dagId);
		expect(found[0]!.status).toBe("running");
	});

	it("is a pure read: does not mutate or create any files", () => {
		// On an empty dir, calling findRunning must not create files.
		store.findRunning();
		const emptySnap = snapshotDir();
		store.findRunning();
		expect(snapshotDir()).toEqual(emptySnap);
	});

	function snapshotDir(): string[] {
		const { readdirSync } = require("node:fs") as typeof import("node:fs");
		return readdirSync(dagDir).sort();
	}

	// Compile-time type guard ensuring the returned element is a DagRecord.
	it("returns DagRecord[] typed elements", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");
		const found: DagRecord[] = store.findRunning();
		expect(found.length).toBeGreaterThanOrEqual(1);
	});
});

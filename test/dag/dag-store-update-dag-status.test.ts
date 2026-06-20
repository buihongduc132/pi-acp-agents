import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";
import type {
	DagIndexEntry,
	DagRecord,
	DagStatus,
	DagTaskDefinition,
} from "../../src/config/types.js";

/**
 * Task 2.5: Implement `updateDagStatus(dagId, status)` — transitions
 * DAG-level status. Each DAG-level status transition must be persisted to
 * `<dagId>.json` (record.status + record.updatedAt) and reflected in
 * `dag-index.json` (entry.status + entry.updatedAt). A transition to a
 * terminal status (completed / failed / cancelled) stamps `completedAt`.
 */
describe("DagStore#updateDagStatus (task 2.5)", () => {
	let tmpDir: string;
	let dagDir: string;
	let dagIndexFile: string;
	let store: DagStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-update-status-"));
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

	it("exposes an updateDagStatus method on DagStore", () => {
		expect(typeof store.updateDagStatus).toBe("function");
	});

	it("transitions the DAG record status and returns the updated record", () => {
		const created = store.create({ tasks: linear });
		const updated = store.updateDagStatus(created.dagId, "running");
		expect(updated).not.toBeNull();
		expect(updated!.dagId).toBe(created.dagId);
		expect(updated!.status).toBe("running");
	});

	it("persists the new status to <dagId>.json on disk", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");
		const onDisk = JSON.parse(
			readFileSync(join(dagDir, `${created.dagId}.json`), "utf-8"),
		) as DagRecord;
		expect(onDisk.status).toBe("running");
	});

	it("is reflected by a subsequent get() call (round-trips through disk)", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "failed");
		const refetched = store.get(created.dagId)!;
		expect(refetched.status).toBe("failed");
	});

	it("bumps DagRecord.updatedAt on every transition", () => {
		const created = store.create({ tasks: linear });
		const before = store.get(created.dagId)!.updatedAt;
		store.updateDagStatus(created.dagId, "running");
		const after = store.get(created.dagId)!.updatedAt;
		expect(after >= before).toBe(true);
	});

	it("stamps completedAt when transitioning to a terminal status (completed)", () => {
		const created = store.create({ tasks: linear });
		const updated = store.updateDagStatus(created.dagId, "completed");
		expect(updated!.completedAt).toBeTruthy();
		// Persisted to disk too.
		const onDisk = JSON.parse(
			readFileSync(join(dagDir, `${created.dagId}.json`), "utf-8"),
		) as DagRecord;
		expect(onDisk.completedAt).toBeTruthy();
	});

	it("stamps completedAt when transitioning to a terminal status (failed)", () => {
		const created = store.create({ tasks: linear });
		const updated = store.updateDagStatus(created.dagId, "failed");
		expect(updated!.completedAt).toBeTruthy();
	});

	it("stamps completedAt when transitioning to a terminal status (cancelled)", () => {
		const created = store.create({ tasks: linear });
		const updated = store.updateDagStatus(created.dagId, "cancelled");
		expect(updated!.completedAt).toBeTruthy();
	});

	it("does not stamp completedAt for a non-terminal transition (running)", () => {
		const created = store.create({ tasks: linear });
		const updated = store.updateDagStatus(created.dagId, "running");
		expect(updated!.completedAt).toBeUndefined();
	});

	it("reflects the new status in dag-index.json", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "completed");
		const index = JSON.parse(
			readFileSync(dagIndexFile, "utf-8"),
		) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === created.dagId)!;
		expect(entry.status).toBe("completed");
		expect(entry.completedAt).toBeTruthy();
	});

	it("updates dag-index.json entry status for the cancelled terminal state", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "cancelled");
		const index = JSON.parse(
			readFileSync(dagIndexFile, "utf-8"),
		) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === created.dagId)!;
		expect(entry.status).toBe("cancelled");
		expect(entry.completedAt).toBeTruthy();
	});

	it("returns null and makes no disk change when the dagId does not exist", () => {
		const result = store.updateDagStatus("missing", "running");
		expect(result).toBeNull();
		// No stray index entry created (readIndex returns [] when file is absent).
		if (existsSync(dagIndexFile)) {
			const indexFile = readFileSync(dagIndexFile, "utf-8");
			expect(JSON.parse(indexFile)).toEqual([]);
		}
	});

	it("supports stale as a valid DAG-level status transition", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "running");
		const updated = store.updateDagStatus(created.dagId, "stale");
		expect(updated!.status).toBe("stale");
		// stale is NOT terminal — no completedAt stamp.
		expect(updated!.completedAt).toBeUndefined();
	});
});

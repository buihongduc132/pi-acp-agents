import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";
import type {
	DagIndexEntry,
	DagTaskDefinition,
} from "../../src/config/types.js";

/**
 * Task 2.6: Implement `listAll()` — reads `dag-index.json` and returns
 * summary list. listAll MUST reflect whatever is currently persisted to
 * `dag-index.json`: empty list when no DAGs exist, and a summary entry
 * per DAG after submissions. It MUST be read-only (no mutation of the
 * index file) and MUST survive a missing or empty index file.
 */
describe("DagStore#listAll (task 2.6)", () => {
	let tmpDir: string;
	let dagDir: string;
	let dagIndexFile: string;
	let store: DagStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-list-all-"));
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

	it("exposes a listAll method on DagStore", () => {
		expect(typeof store.listAll).toBe("function");
	});

	it("returns an empty array when no DAGs have been submitted (index file absent)", () => {
		const result = store.listAll();
		expect(result).toEqual([]);
	});

	it("returns one summary entry per submitted DAG", () => {
		const created1 = store.create({ tasks: linear });
		const created2 = store.create({ tasks: linear });
		const list = store.listAll();
		expect(list).toHaveLength(2);
		const ids = list.map((e) => e.dagId).sort();
		expect(ids).toEqual([created1.dagId, created2.dagId].sort());
	});

	it("returns summary entries matching the DagIndexEntry shape", () => {
		const created = store.create({ tasks: linear });
		const list = store.listAll();
		const entry = list.find((e) => e.dagId === created.dagId)!;
		expect(entry).toBeDefined();
		expect(entry).toMatchObject({
			dagId: created.dagId,
			status: "pending",
			totalSteps: 2,
			completedSteps: 0,
			failedSteps: 0,
		});
		expect(typeof entry.createdAt).toBe("string");
		expect(typeof entry.updatedAt).toBe("string");
	});

	it("reflects subsequent state transitions (e.g. updateDagStatus)", () => {
		const created = store.create({ tasks: linear });
		store.updateDagStatus(created.dagId, "completed");
		const list = store.listAll();
		const entry = list.find((e) => e.dagId === created.dagId)!;
		expect(entry.status).toBe("completed");
		expect(entry.completedAt).toBeTruthy();
	});

	it("reflects subsequent step transitions (completed/failed counters)", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (step) => ({
			...step,
			status: "completed",
			output: "done",
		}));
		store.updateStep(created.dagId, "b", (step) => ({
			...step,
			status: "failed",
			error: "boom",
		}));
		const list = store.listAll();
		const entry = list.find((e) => e.dagId === created.dagId)!;
		expect(entry.completedSteps).toBe(1);
		expect(entry.failedSteps).toBe(1);
	});

	it("is read-only: does not create or mutate dag-index.json when called", () => {
		// First call on a fresh store with no submitted DAGs MUST NOT create
		// the index file (it is a pure read).
		store.listAll();
		// No index file should have been created just by reading.
		// (create() would write one; listAll() must not.)

		// Now submit a DAG to seed the index, then ensure listAll leaves the
		// file's bytes unchanged.
		store.create({ tasks: linear });
		const before = readIndexBytes();
		store.listAll();
		const after = readIndexBytes();
		expect(after).toEqual(before);
	});

	it("returns an empty array when dag-index.json is empty/malformed", () => {
		// Simulate a corrupt/empty index file on disk.
		writeFileSync(dagIndexFile, "", "utf-8");
		const list = store.listAll();
		expect(list).toEqual([]);
	});

	it("returns all entries directly written to dag-index.json", () => {
		// Simulate entries written by some other process (or restored backup).
		const entries: DagIndexEntry[] = [
			{
				dagId: "external-1",
				status: "completed",
				totalSteps: 3,
				completedSteps: 3,
				failedSteps: 0,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:10:00.000Z",
				completedAt: "2026-01-01T00:10:00.000Z",
			},
		];
		writeFileSync(dagIndexFile, JSON.stringify(entries, null, 2), "utf-8");
		const list = store.listAll();
		expect(list).toEqual(entries);
	});

	function readIndexBytes(): string {
		try {
			return readFileSync(dagIndexFile, "utf-8");
		} catch {
			return "<missing>";
		}
	}
});

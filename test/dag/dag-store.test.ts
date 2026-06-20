/**
 * Task 2.8: Consolidated unit tests for DagStore.
 *
 * This is the umbrella test for the file-backed DAG state persistence layer
 * (`src/dag/dag-store.ts`). It exercises the full public surface end-to-end
 * across the lifecycle of a DAG record — construction (directory bootstrap),
 * creation, read-back, step transitions, DAG-level status transitions,
 * listing, and resume-on-restart scanning — and asserts the on-disk
 * persistence contract from design.md (D1, D7) and the dag-resume spec.
 *
 * The per-method test files (dag-store-create.test.ts, etc.) drive the RED
 * phase of tasks 2.1–2.7. This file is the integration-style coverage that
 * ties the whole API together and guards against regressions that span
 * multiple methods (e.g. create → updateStep → listAll → findRunning).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";
import type {
	DagIndexEntry,
	DagRecord,
	DagStepRecord,
	DagStatus,
	DagTaskDefinition,
} from "../../src/config/types.js";

const LINEAR: DagTaskDefinition[] = [
	{ id: "a", agent: "gemini", prompt: "Research X" },
	{ id: "b", agent: "codex", prompt: "Code based on {a.output}", dependsOn: ["a"] },
];

const DIAMOND: DagTaskDefinition[] = [
	{ id: "a", agent: "gemini", prompt: "Research" },
	{ id: "b", agent: "codex", prompt: "Plan A", dependsOn: ["a"] },
	{ id: "c", agent: "gemini", prompt: "Plan B", dependsOn: ["a"] },
	{ id: "d", agent: "codex", prompt: "Merge {b.output} {c.output}", dependsOn: ["b", "c"] },
];

describe("DagStore — consolidated (task 2.8)", () => {
	let tmpDir: string;
	let dagDir: string;
	let dagIndexFile: string;
	let store: DagStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-store-conso-"));
		dagDir = join(tmpDir, "dag");
		dagIndexFile = join(dagDir, "dag-index.json");
		store = new DagStore({ dagDir, dagIndexFile });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ---------------------------------------------------------------------
	// Construction & directory bootstrap (tasks 2.1 / 2.1a)
	// ---------------------------------------------------------------------
	describe("construction & ensureDagDir", () => {
		it("constructs a DagStore from { dagDir, dagIndexFile } options", () => {
			expect(store).toBeInstanceOf(DagStore);
			expect(store.dagDir).toBe(dagDir);
			expect(store.dagIndexFile).toBe(dagIndexFile);
		});

		it("creates the DAG directory on construction when it does not exist", () => {
			expect(existsSync(dagDir)).toBe(true);
		});

		it("is idempotent: constructing over an existing directory is a no-op", () => {
			// Pre-populate so we can assert the dir is untouched.
			writeFileSync(join(dagDir, "sentinel.txt"), "keep", "utf-8");
			const before = readdirSync(dagDir).sort();
			// Re-construct against the same dir.
			new DagStore({ dagDir, dagIndexFile });
			expect(readdirSync(dagDir).sort()).toEqual(before);
		});

		it("exposes ensureDagDir as a public method that returns void", () => {
			expect(typeof store.ensureDagDir).toBe("function");
			expect(store.ensureDagDir()).toBeUndefined();
		});

		it("creates nested parent directories when the dagDir path is deep", () => {
			const deepDir = join(tmpDir, "nested", "path", "dag");
			const deepIndex = join(deepDir, "dag-index.json");
			const deepStore = new DagStore({ dagDir: deepDir, dagIndexFile: deepIndex });
			expect(existsSync(deepDir)).toBe(true);
			expect(deepStore.dagDir).toBe(deepDir);
		});
	});

	// ---------------------------------------------------------------------
	// create (task 2.2)
	// ---------------------------------------------------------------------
	describe("create", () => {
		it("returns a DagRecord with a generated non-empty uuid-style dagId", () => {
			const record = store.create({ tasks: LINEAR });
			expect(typeof record.dagId).toBe("string");
			expect(record.dagId.length).toBeGreaterThan(8);
		});

		it("generates unique dagIds across successive create calls", () => {
			const a = store.create({ tasks: LINEAR });
			const b = store.create({ tasks: LINEAR });
			expect(a.dagId).not.toBe(b.dagId);
		});

		it("initializes every task as a pending step with retryCount 0 and null output", () => {
			const record = store.create({ tasks: DIAMOND });
			expect(Object.keys(record.steps).sort()).toEqual(["a", "b", "c", "d"]);
			for (const step of Object.values(record.steps)) {
				expect(step.status).toBe("pending");
				expect(step.retryCount).toBe(0);
				expect(step.output).toBeNull();
			}
		});

		it("defaults dependsOn=[] and gate='needs' when omitted, and preserves explicit values", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "root", agent: "gemini", prompt: "p" },
				{ id: "child", agent: "codex", prompt: "c", dependsOn: ["root"], gate: "after" },
			];
			const record = store.create({ tasks });
			expect(record.steps["root"]!.dependsOn).toEqual([]);
			expect(record.steps["root"]!.gate).toBe("needs");
			expect(record.steps["child"]!.dependsOn).toEqual(["root"]);
			expect(record.steps["child"]!.gate).toBe("after");
		});

		it("persists the full record to <dagId>.json on disk and round-trips through get()", () => {
			const record = store.create({
				tasks: LINEAR,
				args: { lang: "TypeScript" },
				options: { failFast: false, maxRetries: 2 },
			});
			const file = join(dagDir, `${record.dagId}.json`);
			expect(existsSync(file)).toBe(true);
			const onDisk = JSON.parse(readFileSync(file, "utf-8")) as DagRecord;
			expect(onDisk.dagId).toBe(record.dagId);
			expect(onDisk.tasks).toEqual(LINEAR);
			expect(onDisk.args).toEqual({ lang: "TypeScript" });
			expect(onDisk.options).toEqual({ failFast: false, maxRetries: 2 });
			expect(onDisk.status).toBe("pending");
			expect(onDisk.currentWave).toBe(0);
		});

		it("writes a summary entry to dag-index.json on creation", () => {
			const record = store.create({ tasks: DIAMOND });
			expect(existsSync(dagIndexFile)).toBe(true);
			const index = readIndex();
			expect(index).toHaveLength(1);
			expect(index[0]!.dagId).toBe(record.dagId);
			expect(index[0]!.status).toBe("pending");
			expect(index[0]!.totalSteps).toBe(4);
			expect(index[0]!.completedSteps).toBe(0);
			expect(index[0]!.failedSteps).toBe(0);
		});

		it("appends to dag-index.json across multiple create calls in submission order", () => {
			const r1 = store.create({ tasks: LINEAR });
			const r2 = store.create({ tasks: DIAMOND });
			const ids = readIndex().map((e) => e.dagId);
			expect(ids).toEqual([r1.dagId, r2.dagId]);
		});

		it("stamps createdAt === updatedAt on both the record and the index entry", () => {
			const record = store.create({ tasks: LINEAR });
			expect(record.createdAt).toBe(record.updatedAt);
			const entry = readIndex().find((e) => e.dagId === record.dagId)!;
			expect(entry.createdAt).toBe(record.createdAt);
			expect(entry.updatedAt).toBe(record.updatedAt);
		});
	});

	// ---------------------------------------------------------------------
	// get (task 2.3)
	// ---------------------------------------------------------------------
	describe("get", () => {
		it("returns the persisted DagRecord for an existing dagId", () => {
			const created = store.create({ tasks: LINEAR });
			const fetched = store.get(created.dagId);
			expect(fetched).not.toBeNull();
			expect(fetched!.dagId).toBe(created.dagId);
			expect(fetched!.steps["a"].status).toBe("pending");
		});

		it("returns null for a dagId that has no backing file", () => {
			expect(store.get("does-not-exist")).toBeNull();
		});

		it("returns null for a corrupt JSON file (does not throw)", () => {
			const created = store.create({ tasks: LINEAR });
			writeFileSync(join(dagDir, `${created.dagId}.json`), "{broken json", "utf-8");
			expect(store.get(created.dagId)).toBeNull();
		});

		it("is a pure read: does not mutate the file or index", () => {
			const created = store.create({ tasks: LINEAR });
			const snapshot = readIndex();
			store.get(created.dagId);
			expect(readIndex()).toEqual(snapshot);
		});
	});

	// ---------------------------------------------------------------------
	// updateStep (task 2.4)
	// ---------------------------------------------------------------------
	describe("updateStep", () => {
		it("applies the mutate callback and returns the new step", () => {
			const created = store.create({ tasks: LINEAR });
			const next = store.updateStep(created.dagId, "a", (s) => ({
				...s,
				status: "running",
				startedAt: "t0",
			}));
			expect(next!.status).toBe("running");
			expect(next!.startedAt).toBe("t0");
		});

		it("persists the transitioned step to <dagId>.json and is visible via get()", () => {
			const created = store.create({ tasks: LINEAR });
			store.updateStep(created.dagId, "a", (s) => ({
				...s,
				status: "completed",
				output: "findings",
				completedAt: "t1",
			}));
			const refetched = store.get(created.dagId)!;
			expect(refetched.steps["a"].status).toBe("completed");
			expect(refetched.steps["a"].output).toBe("findings");
			expect(refetched.steps["b"].status).toBe("pending");
		});

		it("bumps DagRecord.updatedAt on every transition", () => {
			const created = store.create({ tasks: LINEAR });
			const before = store.get(created.dagId)!.updatedAt;
			store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "running" }));
			const after = store.get(created.dagId)!.updatedAt;
			expect(after >= before).toBe(true);
		});

		it("increments completedSteps / failedSteps in dag-index.json per transition", () => {
			const created = store.create({ tasks: LINEAR });
			store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "completed", output: "ok" }));
			store.updateStep(created.dagId, "b", (s) => ({ ...s, status: "failed", error: "boom" }));
			const entry = readIndex().find((e) => e.dagId === created.dagId)!;
			expect(entry.completedSteps).toBe(1);
			expect(entry.failedSteps).toBe(1);
		});

		it("decrements counters when a terminal status is reverted to non-terminal", () => {
			const created = store.create({ tasks: LINEAR });
			store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "completed", output: "ok" }));
			store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "running" }));
			const entry = readIndex().find((e) => e.dagId === created.dagId)!;
			expect(entry.completedSteps).toBe(0);
		});

		it("passes a deep copy to the mutate callback so captured snapshots cannot corrupt persisted state", () => {
			const created = store.create({ tasks: LINEAR });
			let captured: DagStepRecord | undefined;
			store.updateStep(created.dagId, "a", (s) => {
				captured = s;
				return { ...s, status: "running" };
			});
			captured!.status = "completed";
			expect(store.get(created.dagId)!.steps["a"].status).toBe("running");
		});

		it("returns null with no disk change for an unknown dagId", () => {
			expect(store.updateStep("ghost", "a", (s) => ({ ...s, status: "running" }))).toBeNull();
		});

		it("returns null with no disk change for an unknown stepId", () => {
			const created = store.create({ tasks: LINEAR });
			expect(
				store.updateStep(created.dagId, "ghost", (s) => ({ ...s, status: "running" })),
			).toBeNull();
			expect(store.get(created.dagId)!.steps["a"].status).toBe("pending");
		});
	});

	// ---------------------------------------------------------------------
	// updateDagStatus (task 2.5)
	// ---------------------------------------------------------------------
	describe("updateDagStatus", () => {
		it("transitions the DAG-level status and persists it", () => {
			const created = store.create({ tasks: LINEAR });
			const updated = store.updateDagStatus(created.dagId, "running");
			expect(updated!.status).toBe("running");
			expect(store.get(created.dagId)!.status).toBe("running");
		});

		it.each<DagStatus>(["completed", "failed", "cancelled"])(
			"stamps completedAt on the record and index when transitioning to terminal %s",
			(status) => {
				const created = store.create({ tasks: LINEAR });
				store.updateDagStatus(created.dagId, status);
				const record = store.get(created.dagId)!;
				expect(record.status).toBe(status);
				expect(typeof record.completedAt).toBe("string");
				const entry = readIndex().find((e) => e.dagId === created.dagId)!;
				expect(entry.status).toBe(status);
				expect(typeof entry.completedAt).toBe("string");
			},
		);

		it("does not overwrite completedAt on a second terminal transition", () => {
			const created = store.create({ tasks: LINEAR });
			store.updateDagStatus(created.dagId, "running");
			store.updateDagStatus(created.dagId, "completed");
			const first = store.get(created.dagId)!.completedAt!;
			store.updateDagStatus(created.dagId, "failed");
			expect(store.get(created.dagId)!.completedAt).toBe(first);
		});

		it("returns null for an unknown dagId", () => {
			expect(store.updateDagStatus("ghost", "running")).toBeNull();
		});

		it("reflects status changes in the dag-index.json entry", () => {
			const created = store.create({ tasks: LINEAR });
			store.updateDagStatus(created.dagId, "running");
			store.updateDagStatus(created.dagId, "stale");
			const entry = readIndex().find((e) => e.dagId === created.dagId)!;
			expect(entry.status).toBe("stale");
		});
	});

	// ---------------------------------------------------------------------
	// listAll (task 2.6)
	// ---------------------------------------------------------------------
	describe("listAll", () => {
		it("returns an empty array when no DAGs have been submitted", () => {
			expect(store.listAll()).toEqual([]);
		});

		it("returns a summary entry per submitted DAG", () => {
			const r1 = store.create({ tasks: LINEAR });
			const r2 = store.create({ tasks: DIAMOND });
			const all = store.listAll();
			expect(all).toHaveLength(2);
			expect(all.map((e) => e.dagId)).toEqual([r1.dagId, r2.dagId]);
			expect(all[1]!.totalSteps).toBe(4);
		});

		it("does not mutate dag-index.json (pure read)", () => {
			store.create({ tasks: LINEAR });
			const before = readIndex();
			store.listAll();
			expect(readIndex()).toEqual(before);
		});

		it("returns an empty array when dag-index.json is missing or corrupt", () => {
			// Missing: wipe a freshly-constructed store's index (it is created on
			// first create(), so an untouched dir simply has none).
			expect(store.listAll()).toEqual([]);
			// Corrupt:
			writeFileSync(dagIndexFile, "{garbage", "utf-8");
			expect(store.listAll()).toEqual([]);
		});

		it("returns DagIndexEntry-typed elements", () => {
			const r = store.create({ tasks: LINEAR });
			const all: DagIndexEntry[] = store.listAll();
			expect(all[0]!.dagId).toBe(r.dagId);
		});
	});

	// ---------------------------------------------------------------------
	// findRunning (task 2.7)
	// ---------------------------------------------------------------------
	describe("findRunning", () => {
		it("returns an empty array when no DAGs are running", () => {
			store.create({ tasks: LINEAR });
			expect(store.findRunning()).toEqual([]);
		});

		it("returns the full DagRecord for every DAG in the running state", () => {
			const r1 = store.create({ tasks: LINEAR });
			const r2 = store.create({ tasks: DIAMOND });
			store.updateDagStatus(r1.dagId, "running");
			store.updateDagStatus(r2.dagId, "running");
			const found = store.findRunning();
			expect(found).toHaveLength(2);
			expect(found.map((r) => r.dagId).sort()).toEqual([r1.dagId, r2.dagId].sort());
			expect(found.every((r) => r.status === "running")).toBe(true);
			expect(found.every((r) => Array.isArray(r.tasks))).toBe(true);
		});

		it("excludes DAGs in non-running states (pending, completed, failed, cancelled, stale)", () => {
			const pending = store.create({ tasks: LINEAR });
			const completed = store.create({ tasks: LINEAR });
			const failed = store.create({ tasks: LINEAR });
			const cancelled = store.create({ tasks: LINEAR });
			const stale = store.create({ tasks: LINEAR });
			store.updateDagStatus(completed.dagId, "completed");
			store.updateDagStatus(failed.dagId, "failed");
			store.updateDagStatus(cancelled.dagId, "cancelled");
			store.updateDagStatus(stale.dagId, "stale");
			expect(store.findRunning()).toEqual([]);
			// Sanity: the non-running DAGs are all present on disk.
			for (const id of [pending, completed, failed, cancelled, stale]) {
				expect(store.get(id.dagId)).not.toBeNull();
			}
		});

		it("skips the dag-index.json summary file during the scan", () => {
			const r = store.create({ tasks: LINEAR });
			store.updateDagStatus(r.dagId, "running");
			const found = store.findRunning();
			expect(found).toHaveLength(1);
			expect(found[0]!.dagId).toBe(r.dagId);
		});

		it("skips malformed JSON files without throwing", () => {
			const r = store.create({ tasks: LINEAR });
			store.updateDagStatus(r.dagId, "running");
			writeFileSync(join(dagDir, "broken.json"), "{nope", "utf-8");
			const found = store.findRunning();
			expect(found).toHaveLength(1);
			expect(found[0]!.dagId).toBe(r.dagId);
		});

		it("skips non-DagRecord JSON files without throwing", () => {
			const r = store.create({ tasks: LINEAR });
			store.updateDagStatus(r.dagId, "running");
			writeFileSync(join(dagDir, "stray.json"), JSON.stringify({ hello: "world" }), "utf-8");
			expect(store.findRunning()).toHaveLength(1);
		});

		it("returns running DAGs even when dag-index.json is missing", () => {
			const r = store.create({ tasks: LINEAR });
			store.updateDagStatus(r.dagId, "running");
			rmSync(dagIndexFile, { force: true });
			const found = store.findRunning();
			expect(found).toHaveLength(1);
			expect(found[0]!.status).toBe("running");
		});

		it("is a pure read: does not create or mutate files", () => {
			store.findRunning();
			const snap = readdirSync(dagDir).sort();
			store.findRunning();
			expect(readdirSync(dagDir).sort()).toEqual(snap);
		});
	});

	// ---------------------------------------------------------------------
	// Cross-method lifecycle (the integration contract this file guards)
	// ---------------------------------------------------------------------
	describe("end-to-end lifecycle", () => {
		it("drives a full DAG lifecycle: create → run waves → complete → list → (no resume)", () => {
			// Create.
			const created = store.create({
				tasks: DIAMOND,
				args: { topic: "auth" },
				options: { failFast: true, maxRetries: 0 },
			});
			expect(store.get(created.dagId)!.status).toBe("pending");

			// Start execution.
			store.updateDagStatus(created.dagId, "running");

			// Wave 1: step "a".
			store.updateStep(created.dagId, "a", (s) => ({
				...s,
				status: "completed",
				output: "research findings",
			}));

			// Wave 2: "b" and "c" in parallel.
			store.updateStep(created.dagId, "b", (s) => ({
				...s,
				status: "completed",
				output: "plan A",
			}));
			store.updateStep(created.dagId, "c", (s) => ({
				...s,
				status: "completed",
				output: "plan B",
			}));

			// Wave 3: "d".
			store.updateStep(created.dagId, "d", (s) => ({
				...s,
				status: "completed",
				output: "merged result",
			}));

			// All steps terminal → DAG completed.
			store.updateDagStatus(created.dagId, "completed");

			// Listing reflects final summary.
			const entry = store.listAll().find((e) => e.dagId === created.dagId)!;
			expect(entry.status).toBe("completed");
			expect(entry.totalSteps).toBe(4);
			expect(entry.completedSteps).toBe(4);
			expect(entry.failedSteps).toBe(0);
			expect(typeof entry.completedAt).toBe("string");

			// A completed DAG must NOT show up in findRunning (no auto-resume).
			expect(store.findRunning()).toEqual([]);
		});

		it("drives a failFast failure: failed step → dependents skipped → DAG failed", () => {
			const created = store.create({ tasks: DIAMOND });
			store.updateDagStatus(created.dagId, "running");
			// Step "a" fails; "b", "c", "d" are transitive dependents.
			store.updateStep(created.dagId, "a", (s) => ({
				...s,
				status: "failed",
				error: "agent crashed",
			}));
			// Dependents skipped (executor-level behavior simulated here at the
			// store layer to assert persistence).
			store.updateStep(created.dagId, "b", (s) => ({ ...s, status: "skipped" }));
			store.updateStep(created.dagId, "c", (s) => ({ ...s, status: "skipped" }));
			store.updateStep(created.dagId, "d", (s) => ({ ...s, status: "skipped" }));
			store.updateDagStatus(created.dagId, "failed");

			const record = store.get(created.dagId)!;
			expect(record.status).toBe("failed");
			expect(record.steps["a"].status).toBe("failed");
			expect(record.steps["a"].error).toBe("agent crashed");
			expect(record.steps["b"].status).toBe("skipped");
			expect(record.steps["d"].status).toBe("skipped");

			const entry = store.listAll().find((e) => e.dagId === created.dagId)!;
			expect(entry.failedSteps).toBe(1);
			// skipped steps are NOT counted as completed or failed.
			expect(entry.completedSteps).toBe(0);
			expect(typeof entry.completedAt).toBe("string");
		});

		it("drives cancellation: pending steps marked cancelled → DAG cancelled", () => {
			const created = store.create({ tasks: DIAMOND });
			store.updateDagStatus(created.dagId, "running");
			store.updateStep(created.dagId, "a", (s) => ({
				...s,
				status: "completed",
				output: "done",
			}));
			// Cancel before waves 2 & 3 run.
			store.updateStep(created.dagId, "b", (s) => ({ ...s, status: "cancelled" }));
			store.updateStep(created.dagId, "c", (s) => ({ ...s, status: "cancelled" }));
			store.updateStep(created.dagId, "d", (s) => ({ ...s, status: "cancelled" }));
			store.updateDagStatus(created.dagId, "cancelled");

			const record = store.get(created.dagId)!;
			expect(record.status).toBe("cancelled");
			expect(record.steps["a"].status).toBe("completed");
			expect(record.steps["b"].status).toBe("cancelled");
			expect(typeof record.completedAt).toBe("string");
		});

		it("survives a simulated restart: running DAG with partial progress resumes via findRunning", () => {
			const created = store.create({ tasks: DIAMOND });
			store.updateDagStatus(created.dagId, "running");
			// Wave 1 completed; wave 2 step "c" was mid-flight when restart hit.
			store.updateStep(created.dagId, "a", (s) => ({
				...s,
				status: "completed",
				output: "research findings",
			}));
			store.updateStep(created.dagId, "b", (s) => ({
				...s,
				status: "completed",
				output: "plan A",
			}));
			store.updateStep(created.dagId, "c", (s) => ({ ...s, status: "running" }));

			// Simulate a fresh process: brand-new DagStore instance over the
			// same directory, with no in-memory state.
			const restarted = new DagStore({ dagDir, dagIndexFile });
			const resumable = restarted.findRunning();
			expect(resumable).toHaveLength(1);
			const record = resumable[0]!;
			expect(record.dagId).toBe(created.dagId);
			// Completed steps retain their outputs for template resolution.
			expect(record.steps["a"].status).toBe("completed");
			expect(record.steps["a"].output).toBe("research findings");
			expect(record.steps["b"].status).toBe("completed");
			expect(record.steps["c"].status).toBe("running");
			expect(record.steps["d"].status).toBe("pending");
		});

		it("keeps the on-disk file name scheme <dagId>.json one-file-per-DAG", () => {
			store.create({ tasks: LINEAR });
			store.create({ tasks: DIAMOND });
			const files = readdirSync(dagDir).filter(
				(f) => f.endsWith(".json") && f !== "dag-index.json",
			);
			expect(files).toHaveLength(2);
			expect(files.every((f) => /^[0-9a-fA-F-]{8,}\.json$/.test(f))).toBe(true);
		});
	});

	// ----- helpers -----
	function readIndex(): DagIndexEntry[] {
		if (!existsSync(dagIndexFile)) return [];
		return JSON.parse(readFileSync(dagIndexFile, "utf-8")) as DagIndexEntry[];
	}
});

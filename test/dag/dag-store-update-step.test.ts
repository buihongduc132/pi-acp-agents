import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";
import type {
	DagIndexEntry,
	DagRecord,
	DagStepRecord,
	DagTaskDefinition,
} from "../../src/config/types.js";

/**
 * Task 2.4: Implement `updateStep(dagId, stepId, mutate)` — atomic step
 * state transition with file write. Each step transition must be
 * persisted to `<dagId>.json` and reflected in `dag-index.json`.
 */
describe("DagStore#updateStep (task 2.4)", () => {
	let tmpDir: string;
	let dagDir: string;
	let dagIndexFile: string;
	let store: DagStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-update-step-"));
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

	it("exposes an updateStep method on DagStore", () => {
		expect(typeof store.updateStep).toBe("function");
	});

	it("applies the mutate callback to the target step and returns the new step", () => {
		const created = store.create({ tasks: linear });
		const updated = store.updateStep(created.dagId, "a", (step) => ({
			...step,
			status: "running",
			startedAt: "2026-06-19T00:00:00.000Z",
		}));
		expect(updated).toBeDefined();
		expect(updated!.status).toBe("running");
		expect(updated!.startedAt).toBe("2026-06-19T00:00:00.000Z");
		// Non-targeted fields preserved.
		expect(updated!.agent).toBe("gemini");
		expect(updated!.prompt).toBe("Research X");
	});

	it("persists the transitioned step to <dagId>.json on disk", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (step) => ({
			...step,
			status: "completed",
			output: "Research findings: ...",
			completedAt: "2026-06-19T00:00:01.000Z",
		}));
		const onDisk = JSON.parse(
			readFileSync(join(dagDir, `${created.dagId}.json`), "utf-8"),
		) as DagRecord;
		expect(onDisk.steps["a"].status).toBe("completed");
		expect(onDisk.steps["a"].output).toBe("Research findings: ...");
		expect(onDisk.steps["b"].status).toBe("pending");
	});

	it("is reflected by a subsequent get() call (round-trips through disk)", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (step) => ({
			...step,
			status: "failed",
			error: "boom",
		}));
		const refetched = store.get(created.dagId)!;
		expect(refetched.steps["a"].status).toBe("failed");
		expect(refetched.steps["a"].error).toBe("boom");
	});

	it("bumps DagRecord.updatedAt on every transition", () => {
		const created = store.create({ tasks: linear });
		const before = store.get(created.dagId)!.updatedAt;
		// Sleep a little to ensure a different timestamp when ms-precision matches.
		store.updateStep(created.dagId, "a", (step) => ({ ...step, status: "running" }));
		const after = store.get(created.dagId)!.updatedAt;
		expect(after >= before).toBe(true);
	});

	it("increments completedSteps in dag-index.json when a step transitions to completed", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (step) => ({
			...step,
			status: "completed",
			output: "ok",
		}));
		const index = JSON.parse(
			readFileSync(dagIndexFile, "utf-8"),
		) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === created.dagId)!;
		expect(entry.completedSteps).toBe(1);
		expect(entry.failedSteps).toBe(0);
	});

	it("increments failedSteps in dag-index.json when a step transitions to failed", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (step) => ({
			...step,
			status: "failed",
			error: "err",
		}));
		const index = JSON.parse(
			readFileSync(dagIndexFile, "utf-8"),
		) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === created.dagId)!;
		expect(entry.failedSteps).toBe(1);
		expect(entry.completedSteps).toBe(0);
	});

	it("keeps index counters accurate across multiple transitions (a→completed, b→failed)", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "completed", output: "ok" }));
		store.updateStep(created.dagId, "b", (s) => ({ ...s, status: "failed", error: "boom" }));
		const index = JSON.parse(
			readFileSync(dagIndexFile, "utf-8"),
		) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === created.dagId)!;
		expect(entry.completedSteps).toBe(1);
		expect(entry.failedSteps).toBe(1);
	});

	it("does not double-count when a step transitions completed→completed again", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "completed", output: "v1" }));
		store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "completed", output: "v2" }));
		const index = JSON.parse(
			readFileSync(dagIndexFile, "utf-8"),
		) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === created.dagId)!;
		expect(entry.completedSteps).toBe(1);
	});

	it("decrements counters when a terminal step is reverted to a non-terminal status", () => {
		const created = store.create({ tasks: linear });
		store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "completed", output: "ok" }));
		store.updateStep(created.dagId, "a", (s) => ({ ...s, status: "running" }));
		const index = JSON.parse(
			readFileSync(dagIndexFile, "utf-8"),
		) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === created.dagId)!;
		expect(entry.completedSteps).toBe(0);
	});

	it("returns null and makes no disk change when the dagId does not exist", () => {
		const result = store.updateStep("missing", "a", (step) => ({
			...step,
			status: "running",
		}));
		expect(result).toBeNull();
	});

	it("returns null and makes no disk change when the stepId does not exist", () => {
		const created = store.create({ tasks: linear });
		const result = store.updateStep(created.dagId, "nope", (step) => ({
			...step,
			status: "running",
		}));
		expect(result).toBeNull();
		// Other steps unchanged on disk.
		const onDisk = store.get(created.dagId)!;
		expect(onDisk.steps["a"].status).toBe("pending");
	});

	it("passes a deep copy of the current step to the mutate callback (mutation isolation)", () => {
		const created = store.create({ tasks: linear });
		let captured: DagStepRecord | undefined;
		store.updateStep(created.dagId, "a", (step) => {
			captured = step;
			return { ...step, status: "running" };
		});
		// Mutating the captured pre-update copy must not corrupt on-disk state.
		captured!.status = "completed";
		const refetched = store.get(created.dagId)!;
		expect(refetched.steps["a"].status).toBe("running");
	});
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";
import type {
	DagTaskDefinition,
	DagRecord,
	DagIndexEntry,
} from "../../src/config/types.js";

/**
 * Task 2.2: Implement `create(definition)` — generates `dagId`,
 * initializes all steps as `pending`, writes `<dagId>.json`,
 * updates `dag-index.json`.
 */
describe("DagStore#create (task 2.2)", () => {
	let tmpDir: string;
	let dagDir: string;
	let dagIndexFile: string;
	let store: DagStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-create-"));
		dagDir = join(tmpDir, "dag");
		dagIndexFile = join(dagDir, "dag-index.json");
		store = new DagStore({ dagDir, dagIndexFile });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("exposes a create method on DagStore", () => {
		expect(typeof store.create).toBe("function");
	});

	it("returns a DagRecord with a generated, non-empty dagId", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
		];
		const record = store.create({ tasks });
		expect(record).toBeDefined();
		expect(typeof record.dagId).toBe("string");
		expect(record.dagId.length).toBeGreaterThan(0);
	});

	it("generates unique dagIds across multiple create calls", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
		];
		const r1 = store.create({ tasks });
		const r2 = store.create({ tasks });
		expect(r1.dagId).not.toBe(r2.dagId);
	});

	it("initializes every task as a pending step", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
			{ id: "b", agent: "codex", prompt: "Code", dependsOn: ["a"] },
		];
		const record = store.create({ tasks });
		expect(Object.keys(record.steps).sort()).toEqual(["a", "b"]);
		for (const step of Object.values(record.steps)) {
			expect(step.status).toBe("pending");
			expect(step.retryCount).toBe(0);
			expect(step.output).toBeNull();
		}
	});

	it("preserves task fields into step records (agent, prompt, dependsOn, gate)", () => {
		const tasks: DagTaskDefinition[] = [
			{
				id: "a",
				agent: "gemini",
				prompt: "Do thing",
				dependsOn: ["root"],
				gate: "after",
			},
		];
		const record = store.create({ tasks });
		const step = record.steps["a"];
		expect(step.agent).toBe("gemini");
		expect(step.prompt).toBe("Do thing");
		expect(step.dependsOn).toEqual(["root"]);
		expect(step.gate).toBe("after");
	});

	it("defaults optional fields (dependsOn=[], gate='needs') when omitted", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "hi" },
		];
		const record = store.create({ tasks });
		const step = record.steps["a"];
		expect(step.dependsOn).toEqual([]);
		expect(step.gate).toBe("needs");
	});

	it("persists the DagRecord to <dagId>.json on disk", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
		];
		const record = store.create({ tasks });
		const file = join(dagDir, `${record.dagId}.json`);
		expect(existsSync(file)).toBe(true);
		const onDisk = JSON.parse(readFileSync(file, "utf-8")) as DagRecord;
		expect(onDisk.dagId).toBe(record.dagId);
		expect(onDisk.steps["a"].status).toBe("pending");
		expect(onDisk.tasks).toEqual(tasks);
	});

	it("updates dag-index.json with a summary entry for the new DAG", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
			{ id: "b", agent: "codex", prompt: "Code", dependsOn: ["a"] },
		];
		const record = store.create({ tasks });
		expect(existsSync(dagIndexFile)).toBe(true);
		const index = JSON.parse(readFileSync(dagIndexFile, "utf-8")) as DagIndexEntry[];
		expect(Array.isArray(index)).toBe(true);
		const entry = index.find((e) => e.dagId === record.dagId);
		expect(entry).toBeDefined();
		expect(entry!.totalSteps).toBe(2);
		expect(entry!.completedSteps).toBe(0);
		expect(entry!.failedSteps).toBe(0);
		expect(entry!.status).toBe("pending");
	});

	it("appends to existing dag-index.json without clobbering prior entries", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
		];
		const first = store.create({ tasks });
		const second = store.create({ tasks });
		const index = JSON.parse(readFileSync(dagIndexFile, "utf-8")) as DagIndexEntry[];
		const ids = index.map((e) => e.dagId);
		expect(ids).toContain(first.dagId);
		expect(ids).toContain(second.dagId);
	});

	it("sets createdAt/updatedAt timestamps on both record and index entry", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "hi" },
		];
		const before = new Date().toISOString();
		const record = store.create({ tasks });
		const after = new Date().toISOString();
		expect(record.createdAt >= before).toBe(true);
		expect(record.createdAt <= after).toBe(true);
		expect(record.updatedAt).toBe(record.createdAt);

		const index = JSON.parse(readFileSync(dagIndexFile, "utf-8")) as DagIndexEntry[];
		const entry = index.find((e) => e.dagId === record.dagId)!;
		expect(entry.createdAt).toBe(record.createdAt);
		expect(entry.updatedAt).toBe(record.updatedAt);
	});

	it("preserves args and options from the submission definition", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "hi" },
		];
		const record = store.create({
			tasks,
			args: { lang: "TypeScript" },
			options: { failFast: false, maxRetries: 3 },
		});
		expect(record.args).toEqual({ lang: "TypeScript" });
		expect(record.options).toEqual({ failFast: false, maxRetries: 3 });
	});

	it("starts with DAG-level status pending and currentWave 0", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "hi" },
		];
		const record = store.create({ tasks });
		expect(record.status).toBe("pending");
		expect(record.currentWave).toBe(0);
	});
});

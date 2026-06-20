import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";
import type { DagRecord, DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 2.3: Implement `get(dagId)` — reads and returns a `DagRecord`.
 */
describe("DagStore#get (task 2.3)", () => {
	let tmpDir: string;
	let dagDir: string;
	let dagIndexFile: string;
	let store: DagStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-get-"));
		dagDir = join(tmpDir, "dag");
		dagIndexFile = join(dagDir, "dag-index.json");
		store = new DagStore({ dagDir, dagIndexFile });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("exposes a get method on DagStore", () => {
		expect(typeof store.get).toBe("function");
	});

	it("returns the DagRecord previously created by create()", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "Research X" },
			{ id: "b", agent: "codex", prompt: "Code", dependsOn: ["a"] },
		];
		const created = store.create({ tasks });
		const fetched = store.get(created.dagId);
		expect(fetched).toBeDefined();
		expect(fetched!.dagId).toBe(created.dagId);
		expect(fetched!.tasks).toEqual(tasks);
		expect(Object.keys(fetched!.steps).sort()).toEqual(["a", "b"]);
	});

	it("reads a faithful deep copy of the persisted record (round-trips steps)", () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "hi", gate: "after" },
		];
		const created = store.create({
			tasks,
			args: { lang: "TypeScript" },
			options: { failFast: false, maxRetries: 2 },
		});
		const fetched = store.get(created.dagId) as DagRecord;
		expect(fetched.status).toBe("pending");
		expect(fetched.args).toEqual({ lang: "TypeScript" });
		expect(fetched.options).toEqual({ failFast: false, maxRetries: 2 });
		expect(fetched.steps["a"].gate).toBe("after");
		expect(fetched.steps["a"].status).toBe("pending");
		expect(fetched.createdAt).toBe(created.createdAt);
	});

	it("returns null for a dagId that does not exist", () => {
		expect(store.get("nonexistent-dag-id")).toBeNull();
	});

	it("returns the freshest on-disk state (reflects external writes)", async () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "hi" },
		];
		const created = store.create({ tasks });
		const first = store.get(created.dagId)!;
		expect(first.status).toBe("pending");

		// Simulate an external transition by rewriting the file.
		const mutated: DagRecord = { ...first, status: "completed" };
		await writeFile(
			join(dagDir, `${created.dagId}.json`),
			JSON.stringify(mutated, null, 2) + "\n",
			"utf-8",
		);

		const refetched = store.get(created.dagId)!;
		expect(refetched.status).toBe("completed");
	});

	it("returns null for a dagId whose file is missing but was indexed", async () => {
		const tasks: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "hi" },
		];
		const created = store.create({ tasks });
		await rm(join(dagDir, `${created.dagId}.json`));
		expect(store.get(created.dagId)).toBeNull();
	});
});

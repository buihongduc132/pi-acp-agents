import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";

/**
 * Task 2.1: Create `src/dag/dag-store.ts` with `DagStore` class
 * (include `safeMkdir(dagDir)` in constructor).
 *
 * These tests assert only the construction behavior for task 2.1.
 * The full DagStore method surface (create/get/updateStep/...) is covered
 * by later tasks (2.2-2.8).
 */
describe("DagStore (constructor — task 2.1)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-store-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates the DAG directory under the provided runtime root on construction", () => {
		const expectedDagDir = join(tmpDir, "dag");
		expect(existsSync(expectedDagDir)).toBe(false);

		new DagStore({ dagDir: expectedDagDir, dagIndexFile: join(expectedDagDir, "dag-index.json") });

		expect(existsSync(expectedDagDir)).toBe(true);
		const stat = statSync(expectedDagDir);
		expect(stat.isDirectory()).toBe(true);
	});

	it("is safe to construct when the DAG directory already exists", () => {
		const expectedDagDir = join(tmpDir, "dag");
		// Pre-create the directory
		new DagStore({ dagDir: expectedDagDir, dagIndexFile: join(expectedDagDir, "dag-index.json") });
		// Construct again — must not throw
		expect(() => {
			new DagStore({ dagDir: expectedDagDir, dagIndexFile: join(expectedDagDir, "dag-index.json") });
		}).not.toThrow();
		expect(existsSync(expectedDagDir)).toBe(true);
	});

	it("exports the DagStore class", () => {
		expect(typeof DagStore).toBe("function");
		const store = new DagStore({
			dagDir: join(tmpDir, "dag"),
			dagIndexFile: join(tmpDir, "dag", "dag-index.json"),
		});
		expect(store).toBeInstanceOf(DagStore);
	});
});

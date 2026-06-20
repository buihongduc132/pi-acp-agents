import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DagStore } from "../../src/dag/dag-store.js";

/**
 * Task 2.1a: Implement `ensureDagDir()` — create `~/.pi/acp-agents/dag/`
 * subdirectory if not exists.
 *
 * The constructor already calls `safeMkdir(dagDir)` (task 2.1), but this
 * method exposes an explicit, idempotent public entry point that other
 * DagStore operations (and the executor on resume) can call to guarantee
 * the directory exists before touching files.
 */
describe("DagStore#ensureDagDir (task 2.1a)", () => {
	let tmpDir: string;
	let dagDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-dag-ensure-"));
		dagDir = join(tmpDir, "dag");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("exposes an ensureDagDir method on DagStore", () => {
		const store = new DagStore({
			dagDir,
			dagIndexFile: join(dagDir, "dag-index.json"),
		});
		expect(typeof store.ensureDagDir).toBe("function");
	});

	it("creates the DAG directory when it does not exist", () => {
		// Bypass the constructor's own mkdir by constructing against a
		// different dir, then pointing the store at the not-yet-existing dir.
		const store = new DagStore({
			dagDir: join(tmpDir, "other"),
			dagIndexFile: join(tmpDir, "other", "dag-index.json"),
		});
		// Re-point the store's dagDir to a fresh path that does not exist yet.
		const freshDir = join(tmpDir, "fresh-dag");
		expect(existsSync(freshDir)).toBe(false);
		(store as unknown as { dagDir: string }).dagDir = freshDir;

		store.ensureDagDir();

		expect(existsSync(freshDir)).toBe(true);
		expect(statSync(freshDir).isDirectory()).toBe(true);
	});

	it("is idempotent — does not throw when the directory already exists", () => {
		const store = new DagStore({
			dagDir,
			dagIndexFile: join(dagDir, "dag-index.json"),
		});
		expect(existsSync(dagDir)).toBe(true);

		expect(() => store.ensureDagDir()).not.toThrow();
		expect(existsSync(dagDir)).toBe(true);
	});

	it("creates nested parent directories (recursive)", () => {
		const store = new DagStore({
			dagDir: join(tmpDir, "other"),
			dagIndexFile: join(tmpDir, "other", "dag-index.json"),
		});
		const nestedDir = join(tmpDir, "a", "b", "c", "dag");
		(store as unknown as { dagDir: string }).dagDir = nestedDir;

		store.ensureDagDir();

		expect(existsSync(nestedDir)).toBe(true);
		expect(statSync(nestedDir).isDirectory()).toBe(true);
	});
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacyLayout } from "../../src/management/legacy-migration.js";

let tmpDir: string;

describe("migrateLegacyLayout", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-migrate-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("moves flat files into legacy/", () => {
		// Create flat-layout files
		for (const f of ["tasks.json", "mailboxes.json", "governance.json", "workers.json"]) {
			writeFileSync(join(tmpDir, f), "{}");
		}

		const { migrated } = migrateLegacyLayout(tmpDir);
		expect(migrated.sort()).toEqual(["governance.json", "mailboxes.json", "tasks.json", "workers.json"]);

		// Files moved to legacy/
		expect(existsSync(join(tmpDir, "legacy", "tasks.json"))).toBe(true);
		expect(existsSync(join(tmpDir, "legacy", "mailboxes.json"))).toBe(true);
		// Original paths no longer exist
		expect(existsSync(join(tmpDir, "tasks.json"))).toBe(false);
	});

	it("leaves session-name-registry.json, session-archive.json, and events.jsonl at root", () => {
		writeFileSync(join(tmpDir, "session-name-registry.json"), "{}");
		writeFileSync(join(tmpDir, "session-archive.json"), "{}");
		writeFileSync(join(tmpDir, "events.jsonl"), "");
		writeFileSync(join(tmpDir, "tasks.json"), "{}");

		migrateLegacyLayout(tmpDir);

		expect(existsSync(join(tmpDir, "session-name-registry.json"))).toBe(true);
		expect(existsSync(join(tmpDir, "session-archive.json"))).toBe(true);
		expect(existsSync(join(tmpDir, "events.jsonl"))).toBe(true);
		expect(existsSync(join(tmpDir, "legacy", "session-name-registry.json"))).toBe(false);
		expect(existsSync(join(tmpDir, "legacy", "session-archive.json"))).toBe(false);
	});

	it("no-op when no flat files exist (idempotent)", () => {
		const { migrated } = migrateLegacyLayout(tmpDir);
		expect(migrated).toEqual([]);
	});

	it("no-op when legacy/ already exists (idempotent)", () => {
		writeFileSync(join(tmpDir, "tasks.json"), "{}");
		migrateLegacyLayout(tmpDir);

		// Second call should be a no-op
		const { migrated } = migrateLegacyLayout(tmpDir);
		expect(migrated).toEqual([]);
	});
});

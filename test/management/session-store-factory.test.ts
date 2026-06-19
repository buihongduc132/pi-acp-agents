import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStoreFactory } from "../../src/management/session-store-factory.js";

let tmpDir: string;

describe("SessionStoreFactory", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-factory-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns cached stores for same sessionId", () => {
		const factory = new SessionStoreFactory(tmpDir);
		const a1 = factory.get("ses-A");
		const a2 = factory.get("ses-A");
		expect(a1).toBe(a2); // Same reference
	});

	it("returns different stores for different sessionIds", () => {
		const factory = new SessionStoreFactory(tmpDir);
		const a = factory.get("ses-A");
		const b = factory.get("ses-B");
		expect(a).not.toBe(b);
		// And they should be independent
		a.taskStore.create({ subject: "From A" });
		expect(b.taskStore.list()).toEqual([]);
	});
});

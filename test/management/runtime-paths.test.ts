import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getRuntimePaths, ensureRuntimeDir } from "../../src/management/runtime-paths.js";
import { existsSync } from "node:fs";

let tmpDir: string;

describe("getRuntimePaths", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-runtime-paths-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("session-scoped paths include <sessionId>/", () => {
		const paths = getRuntimePaths(tmpDir, "ses-abc");
		expect(paths.tasksFile).toContain(join("ses-abc", "tasks.json"));
		expect(paths.mailboxesFile).toContain(join("ses-abc", "mailboxes.json"));
		expect(paths.governanceFile).toContain(join("ses-abc", "governance.json"));
		expect(paths.workersFile).toContain(join("ses-abc", "workers.json"));
	});

	it("global paths do NOT include session segment", () => {
		const paths = getRuntimePaths(tmpDir, "ses-abc");
		expect(paths.sessionNameRegistryFile).toBe(join(tmpDir, "session-name-registry.json"));
		expect(paths.sessionArchiveFile).toBe(join(tmpDir, "session-archive.json"));
		expect(paths.eventLogFile).toBe(join(tmpDir, "events.jsonl"));
	});

	it("without sessionId, session-scoped files resolve at root (backward compat)", () => {
		const paths = getRuntimePaths(tmpDir);
		expect(paths.tasksFile).toBe(join(tmpDir, "tasks.json"));
		expect(paths.sessionNameRegistryFile).toBe(join(tmpDir, "session-name-registry.json"));
	});

	it("custom rootDir override still appends session segment", () => {
		const paths = getRuntimePaths("/custom/path", "ses-xyz");
		expect(paths.tasksFile).toBe(join("/custom/path", "ses-xyz", "tasks.json"));
		expect(paths.sessionNameRegistryFile).toBe(join("/custom/path", "session-name-registry.json"));
	});

	it("different sessionIds produce different paths", () => {
		const p1 = getRuntimePaths(tmpDir, "ses-1");
		const p2 = getRuntimePaths(tmpDir, "ses-2");
		expect(p1.tasksFile).not.toBe(p2.tasksFile);
		expect(p1.workersFile).not.toBe(p2.workersFile);
		// But global paths still match
		expect(p1.sessionNameRegistryFile).toBe(p2.sessionNameRegistryFile);
	});

	it("exposes dagDir and dagIndexFile under rootDir", () => {
		const paths = getRuntimePaths(tmpDir);
		expect(paths.dagDir).toBe(join(tmpDir, "dag"));
		expect(paths.dagIndexFile).toBe(join(tmpDir, "dag", "dag-index.json"));
	});
});

describe("ensureRuntimeDir", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-ensure-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates session subdirectory when sessionId provided", () => {
		ensureRuntimeDir(tmpDir, "ses-test");
		expect(existsSync(join(tmpDir, "ses-test"))).toBe(true);
	});

	it("does NOT create session subdirectory when sessionId absent", () => {
		ensureRuntimeDir(tmpDir);
		// Only rootDir should exist, no session subdirs
		const entries = require("node:fs").readdirSync(tmpDir);
		expect(entries.length).toBe(0);
	});
});

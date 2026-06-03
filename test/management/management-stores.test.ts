import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpEventLog } from "../../src/management/event-log.js";
import { AcpTaskStore } from "../../src/management/task-store.js";

describe("AcpEventLog", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "acp-eventlog-")); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	it("appends an entry to the event log file", () => {
		const log = new AcpEventLog(tmpDir);
		const entry = log.append("session_created", { sessionId: "s1" });
		expect(entry.type).toBe("session_created");
		expect(entry.timestamp).toBeDefined();
		expect(entry.data).toEqual({ sessionId: "s1" });
	});

	it("works without data", () => {
		const log = new AcpEventLog(tmpDir);
		const entry = log.append("ping");
		expect(entry.type).toBe("ping");
		expect(entry.data).toBeUndefined();
	});

	it("persists entries to disk", () => {
		const log = new AcpEventLog(tmpDir);
		log.append("event1");
		log.append("event2");
		// The event file should exist in the runtime dir
		const { existsSync, readFileSync } = require("node:fs");
		const { join } = require("node:path");
		const eventFile = join(tmpDir, "events.jsonl");
		expect(existsSync(eventFile)).toBe(true);
		const content = readFileSync(eventFile, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
	});
});

describe("AcpTaskStore", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "acp-tasks-")); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	it("creates a task", () => {
		const store = new AcpTaskStore(tmpDir);
		const task = store.create({ subject: "Test task", description: "desc" });
		expect(task.id).toBe("1");
		expect(task.subject).toBe("Test task");
		expect(task.status).toBe("pending");
	});

	it("lists tasks excluding deleted by default", () => {
		const store = new AcpTaskStore(tmpDir);
		store.create({ subject: "Task 1" });
		store.create({ subject: "Task 2" });
		expect(store.list()).toHaveLength(2);
	});

	it("filters by status", () => {
		const store = new AcpTaskStore(tmpDir);
		const t1 = store.create({ subject: "T1" });
		store.update(t1.id, (t) => { t.status = "completed"; });
		expect(store.list({ status: "pending" })).toHaveLength(0);
		expect(store.list({ status: "completed" })).toHaveLength(1);
	});

	it("includes deleted when includeDeleted is true", () => {
		const store = new AcpTaskStore(tmpDir);
		const t1 = store.create({ subject: "T1" });
		store.update(t1.id, (t) => { t.status = "deleted"; });
		expect(store.list()).toHaveLength(0);
		expect(store.list({ includeDeleted: true })).toHaveLength(1);
	});

	it("gets task by id", () => {
		const store = new AcpTaskStore(tmpDir);
		const t1 = store.create({ subject: "Find me" });
		expect(store.get(t1.id)?.subject).toBe("Find me");
	});

	it("returns undefined for unknown id", () => {
		const store = new AcpTaskStore(tmpDir);
		expect(store.get("nonexistent")).toBeUndefined();
	});

	it("updates a task", () => {
		const store = new AcpTaskStore(tmpDir);
		const t1 = store.create({ subject: "Original" });
		const updated = store.update(t1.id, (t) => { t.subject = "Updated"; t.status = "in_progress"; });
		expect(updated.subject).toBe("Updated");
		expect(updated.status).toBe("in_progress");
	});

	it("throws when updating nonexistent task", () => {
		const store = new AcpTaskStore(tmpDir);
		expect(() => store.update("nope", () => {})).toThrow(/not found/);
	});

	it("clears completed tasks", () => {
		const store = new AcpTaskStore(tmpDir);
		const t1 = store.create({ subject: "Done" });
		store.create({ subject: "Pending" });
		store.update(t1.id, (t) => { t.status = "completed"; });
		const result = store.clear("completed");
		expect(result.removed).toBe(1);
		expect(result.remaining).toBe(1);
	});

	it("clears all tasks", () => {
		const store = new AcpTaskStore(tmpDir);
		store.create({ subject: "A" });
		store.create({ subject: "B" });
		const result = store.clear("all");
		expect(result.removed).toBe(2);
		expect(result.remaining).toBe(0);
	});

	it("handles corrupted file gracefully", () => {
		const { writeFileSync: wf, mkdirSync: md } = require("node:fs");
		const { join } = require("node:path");
		md(tmpDir, { recursive: true });
		wf(join(tmpDir, "tasks.json"), "bad json {{{");
		const store = new AcpTaskStore(tmpDir);
		expect(store.list()).toHaveLength(0);
	});

	it("creates task with assignee", () => {
		const store = new AcpTaskStore(tmpDir);
		const task = store.create({ subject: "Assigned", assignee: "agent-1" });
		expect(task.assignee).toBe("agent-1");
	});
});

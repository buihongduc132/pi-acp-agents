/**
 * Isolation tests for session-scoped stores.
 * Verifies that data written by one session is invisible to another.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpTaskStore } from "../../src/management/task-store.js";
import { MailboxManager } from "../../src/management/mailbox-manager.js";
import { WorkerStore } from "../../src/management/worker-store.js";

let tmpDir: string;

describe("Session isolation — AcpTaskStore", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-isolation-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("two stores with different sessionIds cannot see each other's tasks", () => {
		const storeA = new AcpTaskStore(tmpDir, "ses-A");
		const storeB = new AcpTaskStore(tmpDir, "ses-B");

		storeA.create({ subject: "Task from A" });
		const bTasks = storeB.list();
		expect(bTasks).toEqual([]);

		const aTasks = storeA.list();
		expect(aTasks).toHaveLength(1);
		expect(aTasks[0].subject).toBe("Task from A");
	});

	it("throws on missing sessionId", () => {
		expect(() => new AcpTaskStore(tmpDir)).toThrow("requires a non-empty sessionId");
		expect(() => new AcpTaskStore(tmpDir, "")).toThrow("requires a non-empty sessionId");
		expect(() => new AcpTaskStore(tmpDir, "  ")).toThrow("requires a non-empty sessionId");
	});
});

describe("Session isolation — MailboxManager", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-isolation-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("messages from session A invisible to session B", () => {
		const mmA = new MailboxManager(tmpDir, "ses-A");
		const mmB = new MailboxManager(tmpDir, "ses-B");

		mmA.send({ from: "alice", to: "bob", message: "from A", kind: "dm" });
		const bMessages = mmB.listAll();
		expect(bMessages).toEqual([]);

		const aMessages = mmA.listAll();
		expect(aMessages).toHaveLength(1);
	});

	it("throws on missing sessionId", () => {
		expect(() => new MailboxManager(tmpDir)).toThrow("requires a non-empty sessionId");
	});
});

describe("Session isolation — WorkerStore", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-isolation-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("workers from session A invisible to session B", () => {
		const wsA = new WorkerStore(tmpDir, "ses-A");
		const wsB = new WorkerStore(tmpDir, "ses-B");

		wsA.register({ name: "worker-1", sessionId: "ses-A", agentName: "gemini" });
		const bWorkers = wsB.list();
		expect(bWorkers).toEqual([]);

		const aWorkers = wsA.list();
		expect(aWorkers).toHaveLength(1);
		expect(aWorkers[0].name).toBe("worker-1");
	});

	it("throws on missing sessionId", () => {
		expect(() => new WorkerStore(tmpDir)).toThrow("requires a non-empty sessionId");
	});
});

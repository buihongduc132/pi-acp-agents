/**
 * TDD tests for WorkerStore (M6: Worker Lifecycle)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerStore } from "../../src/management/worker-store.js";

let tmpDir: string;

describe("WorkerStore", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-worker-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("register", () => {
		it("creates worker record", () => {
			const store = new WorkerStore(tmpDir);
			const worker = store.register({
				name: "worker-1",
				sessionId: "ses-abc",
				agentName: "gemini",
			});
			expect(worker.name).toBe("worker-1");
			expect(worker.sessionId).toBe("ses-abc");
			expect(worker.agentName).toBe("gemini");
			expect(worker.status).toBe("online");
			expect(worker.spawnedAt).toBeTruthy();
			expect(worker.lastActivityAt).toBeTruthy();
		});

		it("re-register updates existing worker (reconnection)", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "ses-old", agentName: "gemini" });
			store.updateStatus("w1", "offline");
			const updated = store.register({ name: "w1", sessionId: "ses-new", agentName: "gemini" });
			expect(updated.sessionId).toBe("ses-new");
			expect(updated.status).toBe("online");
		});
	});

	describe("get", () => {
		it("returns worker by name", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "ses-1", agentName: "gemini" });
			const worker = store.get("w1");
			expect(worker).toBeDefined();
			expect(worker!.name).toBe("w1");
		});

		it("returns undefined for unknown worker", () => {
			const store = new WorkerStore(tmpDir);
			expect(store.get("nonexistent")).toBeUndefined();
		});
	});

	describe("list", () => {
		it("returns all workers", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.register({ name: "w2", sessionId: "s2", agentName: "codex" });
			expect(store.list()).toHaveLength(2);
		});

		it("filters by status", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.register({ name: "w2", sessionId: "s2", agentName: "codex" });
			store.updateStatus("w2", "offline");
			expect(store.list({ status: "online" })).toHaveLength(1);
			expect(store.list({ status: "online" })[0].name).toBe("w1");
		});
	});

	describe("updateStatus", () => {
		it("transitions status", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			const updated = store.updateStatus("w1", "streaming");
			expect(updated.status).toBe("streaming");
			expect(store.get("w1")!.status).toBe("streaming");
		});

		it("throws for unknown worker", () => {
			const store = new WorkerStore(tmpDir);
			expect(() => store.updateStatus("nope", "offline")).toThrow(/not found/i);
		});
	});

	describe("assignTask / unassignTask", () => {
		it("assigns and unassigns task", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.assignTask("w1", "task-5");
			expect(store.get("w1")!.currentTaskId).toBe("task-5");
			store.unassignTask("w1");
			expect(store.get("w1")!.currentTaskId).toBeUndefined();
		});
		it("unassignTask throws when worker not found", () => {
			const store = new WorkerStore(tmpDir);
			expect(() => store.unassignTask("nope")).toThrow(/not found/i);
		});
	});

	describe("unregister", () => {
		it("removes worker", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.unregister("w1");
			expect(store.get("w1")).toBeUndefined();
			expect(store.list()).toHaveLength(0);
		});
	});

	describe("pruneStale", () => {
		it("marks old workers offline", async () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.updateStatus("w1", "idle");
			// Wait 10ms so lastActivityAt is in the past
			await new Promise((r) => setTimeout(r, 10));
			const { pruned } = store.pruneStale(5); // 5ms cutoff
			expect(pruned).toContain("w1");
			expect(store.get("w1")!.status).toBe("offline");
		});

		it("skips already-offline workers", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.updateStatus("w1", "offline");
			const { pruned } = store.pruneStale(0);
			expect(pruned).not.toContain("w1");
		});
	});

	describe("countOnline", () => {
		it("counts non-offline workers", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.register({ name: "w2", sessionId: "s2", agentName: "codex" });
			store.updateStatus("w2", "offline");
			expect(store.countOnline()).toBe(1);
		});

		it("returns 0 when empty", () => {
			const store = new WorkerStore(tmpDir);
			expect(store.countOnline()).toBe(0);
		});
	});

	describe("corrupted file", () => {
		it("graceful fallback to empty", () => {
			const { writeFileSync } = require("node:fs");
			writeFileSync(join(tmpDir, "workers.json"), "not json{{{");
			const store = new WorkerStore(tmpDir);
			expect(store.list()).toEqual([]);
		});
	});

	describe("touch", () => {
		it("updates lastHeartbeatAt and lastActivityAt", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			// small delay to ensure lastActivityAt changes
			const before = new Date();
			const updated = store.touch("w1");
			expect(updated.lastHeartbeatAt).toBeTruthy();
			expect(updated.lastActivityAt).toBeTruthy();
			const recent = new Date(updated.lastActivityAt).getTime();
			expect(recent - before.getTime()).toBeGreaterThanOrEqual(0);
			expect(Date.now() - recent).toBeLessThan(1000);
		});

		it("accumulates tokenCountTotal and toolCallCount deltas", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.touch("w1", { tokenDelta: 100, toolCallDelta: 1 });
			expect(store.get("w1")!.tokenCountTotal).toBe(100);
			expect(store.get("w1")!.toolCallCount).toBe(1);
			store.touch("w1", { tokenDelta: 50, toolCallDelta: 2 });
			expect(store.get("w1")!.tokenCountTotal).toBe(150);
			expect(store.get("w1")!.toolCallCount).toBe(3);
		});

		it("ignores zero deltas", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.touch("w1", { tokenDelta: 0, toolCallDelta: 0 });
			expect(store.get("w1")!.tokenCountTotal ?? 0).toBe(0);
			expect(store.get("w1")!.toolCallCount ?? 0).toBe(0);
		});
	});

	describe("updateMetadata", () => {
		it("stores pending steer in metadata", () => {
			const store = new WorkerStore(tmpDir);
			store.register({ name: "w1", sessionId: "s1", agentName: "gemini" });
			store.updateMetadata("w1", { pendingSteer: "focus on tests" });
			expect(store.get("w1")!.metadata.pendingSteer).toBe("focus on tests");
		});

		it("returns undefined for unknown worker", () => {
			const store = new WorkerStore(tmpDir);
			expect(store.updateMetadata("nope", { key: "val" })).toBeUndefined();
		});
	});
});

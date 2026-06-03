/**
 * TDD tests for TaskStore enhancements (M3: Auto-claim, M5: Dep validation, Priority)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpTaskStore } from "../../src/management/task-store.js";

let tmpDir: string;
let store: AcpTaskStore;

describe("AcpTaskStore — Enhanced", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-task-enh-"));
		store = new AcpTaskStore(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("createWithPriority", () => {
		it("creates task with priority", () => {
			const task = store.createWithPriority({ subject: "Urgent fix", priority: "urgent" });
			expect(task.priority).toBe("urgent");
		});

		it("defaults to normal priority", () => {
			const task = store.createWithPriority({ subject: "Regular task" });
			expect(task.priority).toBe("normal");
		});

		it("maintains reverse edges (blocks[]) for deps", () => {
			const t1 = store.createWithPriority({ subject: "Setup" });
			const t2 = store.createWithPriority({ subject: "Build", blockedBy: [t1.id] });
			const t1Updated = store.get(t1.id);
			expect(t1Updated!.blocks).toContain(t2.id);
		});

		it("initializes metadata as empty object", () => {
			const task = store.createWithPriority({ subject: "Test" });
			expect(task.metadata).toEqual({});
		});
	});

	describe("findDependencyPath — DFS cycle detection", () => {
		it("detects direct cycle (A→B→A)", () => {
			const t1 = store.create({ subject: "A" });
			const t2 = store.create({ subject: "B", deps: [t1.id] });
			// Try to make A depend on B (would create cycle)
			store.update(t1.id, (t) => { t.blockedBy.push(t2.id); });
			const path = store.findDependencyPath(t1.id, t2.id);
			expect(path).not.toBeNull();
		});

		it("detects transitive cycle (A→B→C→A)", () => {
			const tA = store.create({ subject: "A" });
			const tB = store.create({ subject: "B", deps: [tA.id] });
			const tC = store.create({ subject: "C", deps: [tB.id] });
			// Make A depend on C (creates A→B→C→A cycle)
			store.update(tA.id, (t) => { t.blockedBy.push(tC.id); });
			const path = store.findDependencyPath(tA.id, tC.id);
			expect(path).not.toBeNull();
		});

		it("returns a path for valid forward chain (C→B→A)", () => {
			const t1 = store.create({ subject: "A" });
			const t2 = store.create({ subject: "B", deps: [t1.id] });
			const t3 = store.create({ subject: "C", deps: [t2.id] });
			const path = store.findDependencyPath(t3.id, t1.id);
			// C→B→A is a valid dependency path (not a cycle)
			expect(path).not.toBeNull();
			expect(path).toContain(t3.id);
			expect(path).toContain(t1.id);
		});

		it("returns null for unrelated tasks", () => {
			const t1 = store.create({ subject: "A" });
			const t2 = store.create({ subject: "B" });
			expect(store.findDependencyPath(t1.id, t2.id)).toBeNull();
		});
	});

	describe("isTaskBlocked", () => {
		it("blocked when dep is incomplete", () => {
			const t1 = store.create({ subject: "Setup" });
			const t2 = store.create({ subject: "Build", deps: [t1.id] });
			const result = store.isTaskBlocked(t2.id);
			expect(result.blocked).toBe(true);
			expect(result.blockedBy).toContain(t1.id);
		});

		it("not blocked when all deps completed", () => {
			const t1 = store.create({ subject: "Setup" });
			store.update(t1.id, (t) => { t.status = "completed"; });
			const t2 = store.create({ subject: "Build", deps: [t1.id] });
			const result = store.isTaskBlocked(t2.id);
			expect(result.blocked).toBe(false);
		});

		it("not blocked when no deps", () => {
			const t1 = store.create({ subject: "Standalone" });
			expect(store.isTaskBlocked(t1.id).blocked).toBe(false);
		});
	});

	describe("claimNextAvailable — auto-claim with priority", () => {
		it("claims highest priority first", () => {
			store.createWithPriority({ subject: "Low task", priority: "low" });
			store.createWithPriority({ subject: "Urgent task", priority: "urgent" });
			store.createWithPriority({ subject: "Normal task", priority: "normal" });

			const claimed = store.claimNextAvailable("worker-1");
			expect(claimed).toBeDefined();
			expect(claimed!.subject).toBe("Urgent task");
			expect(claimed!.assignee).toBe("worker-1");
			expect(claimed!.status).toBe("in_progress");
		});

		it("skips blocked tasks, claims unblocked ones", () => {
			const t1 = store.createWithPriority({ subject: "Blocker", priority: "low" });
			store.createWithPriority({ subject: "Blocked task", priority: "urgent", blockedBy: [t1.id] });

			const claimed = store.claimNextAvailable("worker-1");
			// Blocker is claimable (not blocked), Blocked task is not
			expect(claimed).toBeDefined();
			expect(claimed!.subject).toBe("Blocker");
		});

		it("returns null when ALL tasks are blocked", () => {
			const t1 = store.create({ subject: "Incomplete dep" });
			store.createWithPriority({ subject: "Only task", priority: "urgent", blockedBy: [t1.id] });
			// Mark the incomplete dep as completed so it's not claimable
			store.update(t1.id, (t) => { t.status = "in_progress" });
			const claimed = store.claimNextAvailable("worker-1");
			expect(claimed).toBeNull();
		});

		it("skips already assigned tasks", () => {
			store.create({ subject: "Taken", assignee: "other-worker" });
			const claimed = store.claimNextAvailable("worker-1");
			expect(claimed).toBeNull();
		});

		it("skips retry-exhausted tasks", () => {
			const task = store.createWithPriority({ subject: "Exhausted" });
			store.update(task.id, (t) => { t.metadata = { retryExhausted: true }; });
			const claimed = store.claimNextAvailable("worker-1");
			expect(claimed).toBeNull();
		});

		it("skips tasks in cooldown", () => {
			const task = store.createWithPriority({ subject: "Cooling" });
			const future = new Date(Date.now() + 60000).toISOString();
			store.update(task.id, (t) => { t.metadata = { cooldownUntil: future }; });
			const claimed = store.claimNextAvailable("worker-1");
			expect(claimed).toBeNull();
		});

		it("returns null when all tasks claimed", () => {
			store.create({ subject: "Only task", assignee: "worker-1" });
			expect(store.claimNextAvailable("worker-2")).toBeNull();
		});

		it("claims by ID order as tiebreaker", () => {
			store.createWithPriority({ subject: "First", priority: "normal" });
			store.createWithPriority({ subject: "Second", priority: "normal" });

			const claimed = store.claimNextAvailable("worker-1");
			expect(claimed!.subject).toBe("First");
		});
	});

	describe("backward compatibility", () => {
		it("old records get defaults on read", () => {
			// Write a task without priority/blocks/metadata fields
			const taskPath = join(tmpDir, "tasks.json");
			writeFileSync(taskPath, JSON.stringify({
				nextId: 2,
				tasks: [{
					id: "1",
					subject: "Legacy task",
					status: "pending",
					blockedBy: [],
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				}],
			}));

			const legacyStore = new AcpTaskStore(tmpDir);
			const tasks = legacyStore.list();
			expect(tasks).toHaveLength(1);
			expect(tasks[0].priority).toBe("normal");
			expect(tasks[0].blocks).toEqual([]);
			expect(tasks[0].metadata).toEqual({});
		});
	});
});

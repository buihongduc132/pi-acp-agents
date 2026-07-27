/**
 * RED PHASE — Failing tests for Feature 6: Worktree Isolation
 *
 * Tests for:
 *   - WorktreeManager.create(cwd, runId) — creates git worktree
 *   - WorktreeManager.remove(path) — removes git worktree
 *   - acp_spawn({ worktree: true }) — creates worktree for run
 *   - worktreePath set on run record
 *   - cleanup on dispose (unless keepWorktree: true)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function createMockCoordinator(response: string, delayMs = 50) {
	return {
		delegate: vi.fn(async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return { text: response, stopReason: "stop", sessionId: "mock-ses-1" };
		}),
	};
}

function createGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "acp-worktree-repo-"));
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	execSync('git checkout -b main', { cwd: dir, stdio: "pipe" });
	execSync('echo "hello" > README.md', { cwd: dir, stdio: "pipe" });
	execSync("git add -A", { cwd: dir, stdio: "pipe" });
	execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

let repoDir: string;

beforeEach(() => {
	repoDir = createGitRepo();
});

afterEach(() => {
	rmSync(repoDir, { recursive: true, force: true });
	// Clean up any worktrees created in the repo
	try {
		rmSync(join(repoDir, ".worktrees"), { recursive: true, force: true });
	} catch {
		// already gone
	}
});

describe("WorktreeManager", () => {
	it("T6.1: create(cwd, runId) creates a git worktree at <cwd>/.worktrees/acp-<runId>", async () => {
		const { WorktreeManager } = await import("../../src/core/worktree-manager.js");
		const manager = new WorktreeManager();

		const runId = "test-run-1";
		const worktreePath = await manager.create(repoDir, runId);

		expect(worktreePath).toBeDefined();
		expect(worktreePath).toContain(".worktrees");
		expect(worktreePath).toContain(`acp-${runId}`);
		expect(existsSync(worktreePath)).toBe(true);

		// Verify it's a real worktree
		const worktreeList = execSync("git worktree list", { cwd: repoDir, encoding: "utf-8" });
		expect(worktreeList).toContain(`acp-${runId}`);
	});

	it("T6.2: remove(path) removes the git worktree", async () => {
		const { WorktreeManager } = await import("../../src/core/worktree-manager.js");
		const manager = new WorktreeManager();

		const runId = "test-run-2";
		const worktreePath = await manager.create(repoDir, runId);
		expect(existsSync(worktreePath)).toBe(true);

		await manager.remove(worktreePath, repoDir);

		// Worktree directory should be gone (git worktree remove prunes it)
		const worktreeList = execSync("git worktree list", { cwd: repoDir, encoding: "utf-8" });
		expect(worktreeList).not.toContain(`acp-${runId}`);
	});
});

describe("Worktree isolation in AsyncExecutor", () => {
	it("T6.3: start with worktree option creates worktree and sets worktreePath on record", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, repoDir);

		const runId = executor.start("gemini", "Task", undefined, {
			worktree: true,
		} as any);

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();

		const worktreePath = (record as any).worktreePath;
		expect(worktreePath).toBeDefined();
		expect(worktreePath).toContain(`acp-${runId}`);
		expect(existsSync(worktreePath)).toBe(true);

		// Wait for completion
		await new Promise((r) => setTimeout(r, 200));
	});

	it("T6.4: start without worktree option does not create worktree", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, repoDir);

		const runId = executor.start("gemini", "Task");

		const record = executor.getStatus(runId);
		expect(record).toBeDefined();

		const worktreePath = (record as any).worktreePath;
		expect(worktreePath).toBeUndefined();
	});

	it("T6.5: keepWorktree option prevents cleanup on dispose", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, repoDir);

		const runId = executor.start("gemini", "Task", undefined, {
			worktree: true,
			keepWorktree: true,
		} as any);

		await new Promise((r) => setTimeout(r, 200));

		const record = executor.getStatus(runId);
		const worktreePath = (record as any).worktreePath;
		expect(worktreePath).toBeDefined();

		// After completion, worktree should still exist because keepWorktree=true
		expect(existsSync(worktreePath)).toBe(true);

		// Cleanup
		execSync(`rm -rf "${worktreePath}"`, { stdio: "pipe" });
		execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
	});

	it("T6.6: worktree is cleaned up after run completes (when keepWorktree=false)", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, repoDir);

		const runId = executor.start("gemini", "Task", undefined, {
			worktree: true,
			keepWorktree: false,
		} as any);

		const record = executor.getStatus(runId);
		const worktreePath = (record as any).worktreePath;
		expect(worktreePath).toBeDefined();

		await new Promise((r) => setTimeout(r, 300));

		// After completion, worktree should be removed
		expect(existsSync(worktreePath)).toBe(false);

		// Git worktree should be pruned
		const worktreeList = execSync("git worktree list", { cwd: repoDir, encoding: "utf-8" });
		expect(worktreeList).not.toContain(`acp-${runId}`);
	});
});

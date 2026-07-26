/**
 * Tests for worker worktree isolation (G5/A5 fix)
 *
 * Verifies that workers spawned via acp_spawn({ claim: true, worktree: true })
 * get isolated git worktrees that are cleaned up on close.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { WorktreeManager } from '../../src/core/worktree-manager.js';

describe('Worker Worktree Isolation', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'acp-worker-wt-'));
		// Initialize a git repo
		execSync('git init', { cwd: tempDir, stdio: 'pipe' });
		execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
		execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'pipe' });
		execSync('echo "test" > README.md', { cwd: tempDir, stdio: 'pipe' });
		execSync('git add README.md', { cwd: tempDir, stdio: 'pipe' });
		execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: 'pipe' });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('creates worktree for worker with isolated path', () => {
		const manager = new WorktreeManager();
		const workerName = 'worker-1';
		const worktreePath = manager.create(tempDir, workerName);

		expect(worktreePath).toContain('.worktrees');
		expect(worktreePath).toContain(workerName);
		expect(existsSync(worktreePath)).toBe(true);
	});

	it('worktree is isolated from main repo', () => {
		const manager = new WorktreeManager();
		const workerName = 'worker-2';
		const worktreePath = manager.create(tempDir, workerName);

		// Modify file in worktree
		execSync(`echo "modified" > ${join(worktreePath, 'test.txt')}`, { stdio: 'pipe' });

		// Verify main repo doesn't have the file
		expect(existsSync(join(tempDir, 'test.txt'))).toBe(false);
	});

	it('removes worktree on cleanup', () => {
		const manager = new WorktreeManager();
		const workerName = 'worker-3';
		const worktreePath = manager.create(tempDir, workerName);

		expect(existsSync(worktreePath)).toBe(true);

		manager.remove(worktreePath, tempDir);

		expect(existsSync(worktreePath)).toBe(false);
	});

	it('worktree path follows expected pattern', () => {
		const manager = new WorktreeManager();
		const workerName = 'verifier-1';
		const worktreePath = manager.create(tempDir, workerName);

		// Should be under .worktrees directory
		expect(worktreePath).toMatch(/\.worktrees\/acp-verifier-1/);
	});
});

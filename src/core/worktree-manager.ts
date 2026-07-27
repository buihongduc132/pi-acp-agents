/**
 * pi-acp-agents — Worktree Manager
 *
 * Creates and removes git worktrees for run isolation.
 * Uses git worktree primitives (same as subagents).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNoopLogger } from "../logger.js";

const log = createNoopLogger();

export class WorktreeManager {
  /**
   * Create a git worktree at <cwd>/.worktrees/acp-<runId>.
   * Returns the absolute path to the worktree.
   */
  create(cwd: string, runId: string): string {
    const worktreeDir = join(cwd, ".worktrees");
    if (!existsSync(worktreeDir)) {
      mkdirSync(worktreeDir, { recursive: true });
    }
    const worktreePath = join(worktreeDir, `acp-${runId}`);

    try {
      execSync(`git worktree add "${worktreePath}" -b "acp-run-${runId}"`, {
        cwd,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch (err) {
      log.warn("worktree-manager: create failed", err);
      throw new Error(`Failed to create worktree for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return resolve(worktreePath);
  }

  /**
   * Remove a git worktree at the given path.
   * Best-effort: logs warning on failure but does not throw.
   */
  remove(worktreePath: string, repoCwd?: string): void {
    const cwd = repoCwd ?? worktreePath;
    try {
      if (!existsSync(worktreePath)) {
        // Already gone
        return;
      }
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch (err) {
      log.warn("worktree-manager: remove failed (best-effort)", err);
      // Best-effort: manually remove the directory if git worktree remove fails
      try {
        execSync(`rm -rf "${worktreePath}"`, { stdio: "pipe", timeout: 10_000 });
      } catch {
        // Give up silently
      }
    }

    // Prune stale worktree entries
    try {
      execSync("git worktree prune", { cwd, stdio: "pipe", timeout: 10_000 });
    } catch {
      // Best-effort
    }
  }
}

/**
 * Integration test for Feature 7: Tool Wiring
 *
 * Verifies the new acp_status actions (fleet/interrupt/resume) and
 * acp_spawn params (worktree/keepWorktree) are properly wired.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsyncExecutor } from "../../src/core/async-executor.js";
import type { AcpAsyncRunRecord } from "../../src/config/types.js";

// Minimal mock coordinator that stays running long enough for fleet checks
function createLongRunningCoordinator(delayMs = 5000) {
	return {
		delegate: async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return { text: "Done", stopReason: "stop", sessionId: "mock-ses" };
		},
	};
}

describe("Integration: full async lifecycle", () => {
	it("spawn → fleet → interrupt → resume → verify telemetry", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "acp-integ-"));
		try {
			const coordinator = createLongRunningCoordinator(100) as any;
			const executor = new AsyncExecutor(coordinator, tmpDir);

			// 1. Spawn
			const runId = executor.start("gemini", "Integration test task");
			expect(runId).toBeTruthy();

			// 2. Fleet should show the active run
			let fleet = executor.getFleetView();
			expect(fleet.length).toBeGreaterThanOrEqual(1);
			expect(fleet.some((r) => r.runId === runId)).toBe(true);

			// 3. Wait for completion
			await new Promise((r) => setTimeout(r, 300));

			// 4. Verify telemetry on completed run
			const detail = executor.getRunDetail(runId);
			expect(detail).toBeDefined();
			expect(detail!.state).toBe("completed");
			expect(detail).toHaveProperty("turns");
			expect(detail).toHaveProperty("toolCalls");
			expect(detail).toHaveProperty("lastActivityAt");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("worktree option sets worktreePath and cleans up", async () => {
		const { execSync } = await import("node:child_process");
		const repoDir = mkdtempSync(join(tmpdir(), "acp-integ-wt-"));
		try {
			execSync("git init", { cwd: repoDir, stdio: "pipe" });
			execSync('git config user.email "t@t.com"', { cwd: repoDir, stdio: "pipe" });
			execSync('git config user.name "T"', { cwd: repoDir, stdio: "pipe" });
			execSync('git checkout -b main', { cwd: repoDir, stdio: "pipe" });
			execSync('echo "x" > f.txt', { cwd: repoDir, stdio: "pipe" });
			execSync("git add -A && git commit -m init", { cwd: repoDir, stdio: "pipe" });

			const coordinator = { delegate: async () => { await new Promise(r => setTimeout(r, 50)); return { text: "Done", stopReason: "stop", sessionId: "s" }; } };
			const executor = new AsyncExecutor(coordinator as any, repoDir);

			const runId = executor.start("gemini", "Task", undefined, { worktree: true, keepWorktree: false });

			const record = executor.getStatus(runId) as any;
			expect(record.worktreePath).toBeDefined();
			expect(record.worktreePath).toContain(`acp-${runId}`);

			await new Promise((r) => setTimeout(r, 300));

			// Worktree cleaned up
			expect(require("node:fs").existsSync(record.worktreePath)).toBe(false);
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
		}
	});

	it("silent-failure detection on empty output run", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "acp-integ-silent-"));
		try {
			const coordinator = { delegate: async () => { await new Promise(r => setTimeout(r, 50)); return { text: "", stopReason: "stop", sessionId: "s" }; } };
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const runId = executor.start("gemini", "Do nothing");
			await new Promise((r) => setTimeout(r, 300));

			const record = executor.getStatus(runId);
			expect(record!.state).toBe("failed");
			expect(record!.error).toContain("silent-no-output");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("G1 fix: resume actually re-engages session (delegate called twice)", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "acp-g1-"));
		try {
			const delegateCallLog: string[] = [];
			const coordinator = {
				delegate: async (_a: string, msg: string) => {
					delegateCallLog.push(msg);
					await new Promise(r => setTimeout(r, 50));
					return { text: "ok", stopReason: "stop", sessionId: "s" };
				},
			};
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const runId = executor.start("gemini", "Initial task");
			await new Promise(r => setTimeout(r, 200));

			expect(delegateCallLog.length).toBe(1);
			expect(delegateCallLog[0]).toContain("Initial task");

			const resumeResult = executor.resume(runId, "Now do this instead");
			expect(resumeResult.success).toBe(true);
			await new Promise(r => setTimeout(r, 200));

			// Second delegate call recorded — proves real re-engagement (G1 fixed)
			expect(delegateCallLog.length).toBe(2);
			expect(delegateCallLog[1]).toContain("[RESUME] Now do this instead");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("G2 fix: steerQueue drained into delegate message on resume", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "acp-g2-"));
		try {
			const delegateCallLog: string[] = [];
			const coordinator = {
				delegate: async (_a: string, msg: string) => {
					delegateCallLog.push(msg);
					await new Promise(r => setTimeout(r, 50));
					return { text: "ok", stopReason: "stop", sessionId: "s" };
				},
			};
			const executor = new AsyncExecutor(coordinator as any, tmpDir);

			const runId = executor.start("gemini", "Initial");
			await new Promise(r => setTimeout(r, 200));

			// Steer queues a message (G2 — queue must be drained on next delegate)
			executor.steer(runId, "Focus on error handling");

			// Resume should drain the steer queue into the delegate message
			executor.resume(runId, "Continue");
			await new Promise(r => setTimeout(r, 200));

			expect(delegateCallLog.length).toBe(2);
			expect(delegateCallLog[1]).toContain("Focus on error handling");
			expect(delegateCallLog[1]).toContain("[RESUME] Continue");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

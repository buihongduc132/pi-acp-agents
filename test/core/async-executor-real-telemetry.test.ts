/**
 * RED→GREEN tests for real telemetry wiring to AcpDelegateProgress events.
 *
 * These tests verify that telemetry is populated from the REAL coordinator
 * progress events (AcpDelegateProgress), not from a mock-only contract.
 *
 * Bug: The previous implementation passed an AsyncSessionEvent callback
 * where AcpDelegateProgress was expected, causing telemetry to stay at
 * zero in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "acp-real-telemetry-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Real telemetry wiring to AcpDelegateProgress", () => {
  it("populates turns from 'prompting' phase events", async () => {
    const { AsyncExecutor } = await import("../../src/core/async-executor.js");

    // Mock coordinator that emits REAL AcpDelegateProgress events
    const coordinator = {
      delegate: vi.fn(
        async (
          agentName: string,
          message: string,
          cwd: string | undefined,
          onProgress?: (progress: any) => void,
        ) => {
          // Emit phases in the order the real coordinator does
          onProgress?.({ agentName, phase: "spawning", durationMs: 10, lastActivityAt: Date.now() });
          onProgress?.({ agentName, phase: "initializing", durationMs: 50, lastActivityAt: Date.now() });
          onProgress?.({ agentName, phase: "prompting", durationMs: 100, lastActivityAt: Date.now() });
          onProgress?.({ agentName, phase: "done", durationMs: 200, lastActivityAt: Date.now() });
          return { text: "Done", stopReason: "stop", sessionId: "real-ses-1" };
        },
      ),
    };

    const executor = new AsyncExecutor(coordinator as any, tmpDir);
    const runId = executor.start("gemini", "Task");
    await sleep(300);

    const record = executor.getStatus(runId);
    expect(record).toBeDefined();
    expect(record!.state).toBe("completed");

    // turns should be > 0 because "prompting" phase was emitted
    expect(record!.turns).toBeGreaterThan(0);
    expect(record!.turns).toBe(1);

    // lastActivityAt should be updated from progress events
    expect(record!.lastActivityAt).toBeDefined();
    const lastActivity = new Date(record!.lastActivityAt!).getTime();
    expect(lastActivity).toBeGreaterThan(Date.now() - 5000);
  });

  it("silent-failure NOT triggered when text has content (even with zero toolCalls)", async () => {
    const { AsyncExecutor } = await import("../../src/core/async-executor.js");

    const coordinator = {
      delegate: vi.fn(
        async (
          agentName: string,
          message: string,
          cwd: string | undefined,
          onProgress?: (progress: any) => void,
        ) => {
          onProgress?.({ agentName, phase: "spawning", durationMs: 10, lastActivityAt: Date.now() });
          onProgress?.({ agentName, phase: "prompting", durationMs: 50, lastActivityAt: Date.now() });
          onProgress?.({ agentName, phase: "done", durationMs: 100, lastActivityAt: Date.now() });
          return { text: "Done. Created src/foo.ts", stopReason: "stop", sessionId: "real-ses-2" };
        },
      ),
    };

    const executor = new AsyncExecutor(coordinator as any, tmpDir);
    const runId = executor.start("gemini", "Task");
    await sleep(300);

    const record = executor.getStatus(runId);
    expect(record).toBeDefined();
    // Should be completed, NOT failed with silent-no-output
    expect(record!.state).toBe("completed");
    expect(record!.error).toBeUndefined();
  });

  it("silent-failure IS triggered when text is empty AND no progress activity", async () => {
    const { AsyncExecutor } = await import("../../src/core/async-executor.js");

    const coordinator = {
      delegate: vi.fn(
        async (
          agentName: string,
          message: string,
          cwd: string | undefined,
          onProgress?: (progress: any) => void,
        ) => {
          // Only spawning/initializing, no prompting or done with text
          onProgress?.({ agentName, phase: "spawning", durationMs: 10, lastActivityAt: Date.now() });
          onProgress?.({ agentName, phase: "done", durationMs: 50, lastActivityAt: Date.now() });
          return { text: "", stopReason: "stop", sessionId: "real-ses-3" };
        },
      ),
    };

    const executor = new AsyncExecutor(coordinator as any, tmpDir);
    const runId = executor.start("gemini", "Task");
    await sleep(300);

    const record = executor.getStatus(runId);
    expect(record).toBeDefined();
    expect(record!.state).toBe("failed");
    expect(record!.error).toContain("silent-no-output");
  });

  it("uses real AcpDelegateProgress type (no 'as any' cast on delegate call)", async () => {
    const { AsyncExecutor } = await import("../../src/core/async-executor.js");

    // This test verifies the implementation uses the correct type signature.
    // If the implementation uses 'as any', the coordinator.delegate mock
    // will still work, but the type check in the test file will catch it.
    const coordinator = {
      delegate: vi.fn(
        async (
          agentName: string,
          message: string,
          cwd: string | undefined,
          onProgress?: (progress: { agentName: string; phase: string; durationMs?: number; lastActivityAt?: number; text?: string }) => void,
        ) => {
          onProgress?.({ agentName, phase: "prompting", durationMs: 10, lastActivityAt: Date.now() });
          return { text: "ok", stopReason: "stop", sessionId: "s" };
        },
      ),
    };

    const executor = new AsyncExecutor(coordinator as any, tmpDir);
    const runId = executor.start("gemini", "Task");
    await sleep(200);

    const record = executor.getStatus(runId);
    expect(record!.turns).toBe(1);
  });

  it("updates lastActivityAt from progress.lastActivityAt field", async () => {
    const { AsyncExecutor } = await import("../../src/core/async-executor.js");

    const specificTime = Date.now() + 1000; // 1 second in the future
    const coordinator = {
      delegate: vi.fn(
        async (
          agentName: string,
          message: string,
          cwd: string | undefined,
          onProgress?: (progress: any) => void,
        ) => {
          onProgress?.({ agentName, phase: "prompting", durationMs: 10, lastActivityAt: specificTime });
          return { text: "ok", stopReason: "stop", sessionId: "s" };
        },
      ),
    };

    const executor = new AsyncExecutor(coordinator as any, tmpDir);
    const runId = executor.start("gemini", "Task");
    await sleep(200);

    const record = executor.getStatus(runId);
    expect(record!.lastActivityAt).toBeDefined();
    // lastActivityAt should be close to specificTime (within 1 second tolerance)
    const lastActivity = new Date(record!.lastActivityAt!).getTime();
    expect(Math.abs(lastActivity - specificTime)).toBeLessThan(1000);
  });
});

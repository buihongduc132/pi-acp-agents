/**
 * RED PHASE — Failing tests for Feature 5: Fleet View & Status Telemetry
 *
 * Tests for:
 *   - getFleetView() — returns compact list of active runs with telemetry
 *   - Retention filter (runs older than 24h excluded)
 *   - getRunDetail(id) — returns full telemetry for a single run
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AcpAsyncRunRecord } from "../../src/config/types.js";

function createMockCoordinator(response: string, delayMs = 50) {
	return {
		delegate: vi.fn(async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return { text: response, stopReason: "stop", sessionId: "mock-ses-1" };
		}),
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "acp-fleet-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("Fleet view", () => {
	it("T5.1: getFleetView returns compact list of active runs with telemetry fields", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Working...", 5000);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		executor.start("gemini", "Task 1");
		executor.start("codex", "Task 2");

		const fleet = (executor as any).getFleetView();
		expect(fleet).toBeDefined();
		expect(Array.isArray(fleet)).toBe(true);
		expect(fleet.length).toBeGreaterThanOrEqual(2);

		const entry = fleet[0];
		expect(entry).toHaveProperty("runId");
		expect(entry).toHaveProperty("state");
		expect(entry).toHaveProperty("agentName");
		expect(entry).toHaveProperty("lastActivityAt");
		expect(entry).toHaveProperty("turns");
		expect(entry).toHaveProperty("toolCalls");
		expect(entry).toHaveProperty("tokensUsed");
		expect(entry).toHaveProperty("summary");
	});

	it("T5.2: getFleetView filters out inactive runs older than retention window", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		// Create a completed run
		executor.start("gemini", "Old task");
		await new Promise((r) => setTimeout(r, 200));

		// Fleet should return active runs only (no completed runs)
		const fleet = (executor as any).getFleetView();
		expect(fleet).toBeDefined();
		expect(fleet.length).toBe(0);
	});

	it("T5.3: getFleetView sorts entries by lastActivityAt descending", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Working...", 5000);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		executor.start("gemini", "Task 1");
		await new Promise((r) => setTimeout(r, 50));
		executor.start("codex", "Task 2");
		await new Promise((r) => setTimeout(r, 50));
		executor.start("pi", "Task 3");

		const fleet = (executor as any).getFleetView();
		expect(fleet.length).toBeGreaterThanOrEqual(2);

		// Verify descending sort
		for (let i = 0; i < fleet.length - 1; i++) {
			const current = new Date(fleet[i].lastActivityAt).getTime();
			const next = new Date(fleet[i + 1].lastActivityAt).getTime();
			expect(current).toBeGreaterThanOrEqual(next);
		}
	});

	it("T5.4: getFleetView returns empty array when no active runs", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const fleet = (executor as any).getFleetView();
		expect(fleet).toBeDefined();
		expect(Array.isArray(fleet)).toBe(true);
		expect(fleet.length).toBe(0);
	});

	it("T5.5: getRunDetail(id) returns full telemetry for a single run", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const runId = executor.start("gemini", "Detailed task");
		await new Promise((r) => setTimeout(r, 200));

		const detail = (executor as any).getRunDetail(runId);
		expect(detail).toBeDefined();
		expect(detail!.runId).toBe(runId);
		expect(detail).toHaveProperty("turns");
		expect(detail).toHaveProperty("toolCalls");
		expect(detail).toHaveProperty("tokensUsed");
		expect(detail).toHaveProperty("lastActivityAt");
		expect(detail).toHaveProperty("filesWritten");
		expect(detail).toHaveProperty("createdAt");
		expect(detail).toHaveProperty("state");
	});

	it("T5.6: getRunDetail(id) returns undefined for non-existent run", async () => {
		const { AsyncExecutor } = await import("../../src/core/async-executor.js");
		const coordinator = createMockCoordinator("Done", 50);
		const executor = new AsyncExecutor(coordinator as any, tmpDir);

		const detail = (executor as any).getRunDetail("non-existent");
		expect(detail).toBeUndefined();
	});
});

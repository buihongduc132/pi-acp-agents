/**
 * TDD tests for worker tools and status derivation
 * Tasks 7.6-7.11
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AcpWorkerRecord } from "../../src/config/types.js";

// ── 7.10: Status derivation logic ──

function deriveWorkerStatus(worker: AcpWorkerRecord, config?: { workerOnlineMs?: number; workerStaleMs?: number }): { status: string; stale: boolean } {
	const now = Date.now();
	const lastActivity = new Date(worker.lastActivityAt).getTime();
	const ageMs = now - lastActivity;
	const onlineMs = config?.workerOnlineMs ?? 60_000;
	const staleMs = config?.workerStaleMs ?? 60_000;

	if (worker.status === "offline") {
		return { status: "offline", stale: false };
	}
	if (worker.currentTaskId) {
		return { status: "busy", stale: false };
	}
	if (ageMs > staleMs) {
		const ageSec = Math.floor(ageMs / 1000);
		return { status: `stale(${ageSec}s)`, stale: true };
	}
	if (ageMs < onlineMs) {
		return { status: "online", stale: false };
	}
	return { status: "idle", stale: false };
}

function isWorkerStale(worker: AcpWorkerRecord, stallMs?: number): boolean {
	const effectiveStallMs = stallMs ?? 300_000;
	const now = Date.now();
	const ageMs = now - new Date(worker.lastActivityAt).getTime();
	if (ageMs < effectiveStallMs) return false;
	if ((worker.tokenCountTotal ?? 0) > 0) return false;
	if ((worker.toolCallCount ?? 0) > 0) return false;
	return true;
}

function makeWorker(overrides: Partial<AcpWorkerRecord> & { name: string }): AcpWorkerRecord {
	const now = new Date().toISOString();
	return {
		sessionId: "ses-1",
		agentName: "gemini",
		status: "online",
		spawnedAt: now,
		lastActivityAt: now,
		metadata: {},
		...overrides,
	};
}

describe("7.10: Status derivation logic", () => {
	it("returns online when activity is recent", () => {
		const worker = makeWorker({ name: "w1" });
		const result = deriveWorkerStatus(worker);
		expect(result.status).toBe("online");
	});

	it("returns busy when worker has in-flight task", () => {
		const worker = makeWorker({ name: "w1", currentTaskId: "task-1" });
		const result = deriveWorkerStatus(worker);
		expect(result.status).toBe("busy");
	});

	it("returns offline when worker status is offline", () => {
		const worker = makeWorker({ name: "w1", status: "offline" });
		const result = deriveWorkerStatus(worker);
		expect(result.status).toBe("offline");
	});

	it("returns stale when activity exceeds threshold", () => {
		const oldDate = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
		const worker = makeWorker({ name: "w1", lastActivityAt: oldDate });
		const result = deriveWorkerStatus(worker, { workerOnlineMs: 60_000, workerStaleMs: 60_000 });
		expect(result.status).toMatch(/stale/);
		expect(result.stale).toBe(true);
	});

	it("returns idle when activity between online and stale thresholds", () => {
		const midDate = new Date(Date.now() - 45_000).toISOString(); // 45s ago
		const worker = makeWorker({ name: "w1", lastActivityAt: midDate });
		const result = deriveWorkerStatus(worker, { workerOnlineMs: 30_000, workerStaleMs: 60_000 });
		expect(result.status).toBe("idle");
	});
});

describe("7.11: ⚠ stale indicator", () => {
	it("returns false when activity is recent", () => {
		const worker = makeWorker({ name: "w1" });
		expect(isWorkerStale(worker, 300_000)).toBe(false);
	});

	it("returns true when all signals frozen beyond stallTimeoutMs", () => {
		const oldDate = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
		const worker = makeWorker({ name: "w1", lastActivityAt: oldDate });
		expect(isWorkerStale(worker, 300_000)).toBe(true);
	});

	it("returns false when tokens have been used", () => {
		const oldDate = new Date(Date.now() - 600_000).toISOString();
		const worker = makeWorker({ name: "w1", lastActivityAt: oldDate, tokenCountTotal: 100 });
		expect(isWorkerStale(worker, 300_000)).toBe(false);
	});

	it("returns false when tools have been called", () => {
		const oldDate = new Date(Date.now() - 600_000).toISOString();
		const worker = makeWorker({ name: "w1", lastActivityAt: oldDate, toolCallCount: 5 });
		expect(isWorkerStale(worker, 300_000)).toBe(false);
	});

	it("respects custom stallTimeoutMs", () => {
		const recentDate = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
		const worker = makeWorker({ name: "w1", lastActivityAt: recentDate });
		// With 30s stall timeout, this is stale
		expect(isWorkerStale(worker, 30_000)).toBe(true);
		// With 120s stall timeout, this is not stale
		expect(isWorkerStale(worker, 120_000)).toBe(false);
	});
});

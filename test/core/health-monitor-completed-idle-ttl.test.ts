/**
 * RED test for T3 — completedIdleTtlMs.
 *
 * A completed (non-busy, completedAt set) idle session should be reaped by the
 * HealthMonitor once it has been idle longer than `completedIdleTtlMs`, even
 * when `staleTimeoutMs` (the long stall threshold) is much larger.
 *
 * Today the monitor reuses `staleTimeoutMs` for the completed-idle branch, so
 * a 1h staleTimeoutMs keeps reuse sessions (and their subprocesses) alive far
 * too long. This test fails until a dedicated, shorter `completedIdleTtlMs`
 * threshold is threaded through the HealthMonitor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	HealthMonitor,
	type HealthMonitorable,
} from "../../src/core/health-monitor.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type { AcpSessionHandle } from "../../src/config/types.js";

function makeSession(id: string, overrides: Partial<HealthMonitorable> = {}): HealthMonitorable {
	return {
		sessionId: id,
		lastActivityAt: new Date(),
		lastResponseAt: undefined,
		completedAt: undefined,
		busy: false,
		disposed: false,
		...overrides,
	};
}

describe("HealthMonitor — completedIdleTtlMs", () => {
	let monitor: HealthMonitor;

	beforeEach(() => {
		monitor = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000, // 1h — long stall threshold (unchanged)
			completedIdleTtlMs: 5_000, // 5s — new, shorter completed-idle threshold
		});
	});

	afterEach(() => {
		monitor.stop();
	});

	it("reaps a completed-idle session past completedIdleTtlMs but well under staleTimeoutMs", async () => {
		const completedAt = new Date(Date.now() - 6_000); // 6s ago: > 5s TTL, << 1h stall
		const session = makeSession("s1", { completedAt, busy: false });
		monitor.register(session);

		const staleIds = await monitor.check();
		expect(staleIds).toContain("s1");
	});

	it("does NOT reap a completed session still within completedIdleTtlMs", async () => {
		const completedAt = new Date(Date.now() - 1_000); // 1s ago: < 5s TTL
		const session = makeSession("s2", { completedAt, busy: false });
		monitor.register(session);

		const staleIds = await monitor.check();
		expect(staleIds).not.toContain("s2");
	});

	it("leaves stalled-prompt (busy) detection tied to staleTimeoutMs, unaffected by completedIdleTtlMs", async () => {
		// busy session stalled just over 5s — should NOT be reaped because the
		// stall threshold is staleTimeoutMs (1h), not completedIdleTtlMs (5s).
		const lastResponseAt = new Date(Date.now() - 6_000); // 6s ago
		const session = makeSession("s3", {
			busy: true,
			lastResponseAt,
		});
		monitor.register(session);

		const staleIds = await monitor.check();
		expect(staleIds).not.toContain("s3");
	});

	it("invokes onStale for a completed-idle session past completedIdleTtlMs", async () => {
		const onStale = vi.fn().mockResolvedValue(undefined);
		const mon = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
			completedIdleTtlMs: 5_000,
			onStale,
		});

		const session = makeSession("s4", {
			completedAt: new Date(Date.now() - 6_000),
			busy: false,
		});
		mon.register(session);

		const staleIds = await mon.check();
		expect(staleIds).toContain("s4");
		// onStale is invoked by the interval tick; emulate the wiring the
		// monitor.start() loop performs so the assertion reflects real behavior.
		for (const id of staleIds) {
			await mon["opts"].onStale?.(id);
		}
		expect(onStale).toHaveBeenCalledWith("s4");
		mon.stop();
	});

	it("onStale → SessionManager.remove removes the reaped completed-idle handle", async () => {
		// Mirror the production onStale wiring (index.ts) at unit scale:
		// a completed-idle handle, reaped by monitor.check(), is removed from
		// the SessionManager by the onStale callback.
		const sessionMgr = new SessionManager();

		const handle = {
			sessionId: "s5",
			agentName: "gemini",
			cwd: "/tmp",
			createdAt: new Date(),
			lastActivityAt: new Date(),
			completedAt: new Date(Date.now() - 6_000),
			disposed: false,
			accumulatedText: "",
			busy: false,
			dispose: vi.fn().mockResolvedValue(undefined),
		} as unknown as AcpSessionHandle;

		sessionMgr.add(handle);
		expect(sessionMgr.size).toBe(1);

		const mon = new HealthMonitor({
			intervalMs: 1_000,
			staleTimeoutMs: 3_600_000,
			completedIdleTtlMs: 5_000,
			async onStale(sessionId: string) {
				await sessionMgr.remove(sessionId);
			},
		});
		mon.register(handle);

		const staleIds = await mon.check();
		expect(staleIds).toContain("s5");

		// Emulate the monitor.start() loop calling onStale for each reaped id.
		for (const id of staleIds) {
			await mon["opts"].onStale?.(id);
		}

		expect(sessionMgr.size).toBe(0);
		expect(sessionMgr.get("s5")).toBeUndefined();
		mon.stop();
	});
});

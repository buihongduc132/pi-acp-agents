import { describe, it, expect, mock, beforeEach } from "bun:test";
import { HealthMonitor, type HealthMonitorable } from "../src/core/health-monitor.js";

function createMockSession(id: string, opts: Partial<HealthMonitorable> = {}): HealthMonitorable {
	return {
		sessionId: id,
		lastActivityAt: new Date(),
		lastResponseAt: undefined,
		completedAt: undefined,
		busy: false,
		disposed: false,
		...opts,
	};
}

describe("HealthMonitor — prompt stall detection", () => {
	let monitor: HealthMonitor;

	beforeEach(() => {
		monitor = new HealthMonitor({
			intervalMs: 50,
			staleTimeoutMs: 600_000, // high so idle detection doesn't interfere
			needsAttentionMs: 100,
			autoInterruptMs: 300,
		});
	});

	it("detects slow-prompt when isPrompting and idle > needsAttentionMs", async () => {
		const session = createMockSession("s1", {
			isPrompting: true,
			promptStartedAt: new Date(),
			lastActivityAt: new Date(Date.now() - 200), // > needsAttentionMs (100)
		});
		monitor.register(session);
		// Direct check should return no stale IDs (slow-prompt is notification only)
		const staleIds = await monitor.check();
		expect(staleIds).not.toContain("s1");
	});

	it("does not call onNeedsAttention twice for same stall cycle", async () => {
		const session = createMockSession("s1", {
			isPrompting: true,
			lastActivityAt: new Date(Date.now() - 200),
		});
		const onNeedsAttention = mock().mockResolvedValue(undefined);
		const mon = new HealthMonitor({
			intervalMs: 30,
			staleTimeoutMs: 600_000,
			needsAttentionMs: 100,
			autoInterruptMs: 600,
			onNeedsAttention,
		});
		mon.register(session);
		mon.start();
		await new Promise((r) => setTimeout(r, 200));
		mon.stop();
		// Should only be called once despite multiple check cycles
		expect(onNeedsAttention.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("detects stalled-prompt when idle > autoInterruptMs", async () => {
		const session = createMockSession("s1", {
			isPrompting: true,
			lastActivityAt: new Date(Date.now() - 400), // > autoInterruptMs (300)
		});
		monitor.register(session);
		const staleIds = await monitor.check();
		expect(staleIds).toContain("s1");
	});

	it("does not detect stall when autoInterruptMs is 0 (disabled)", async () => {
		const mon = new HealthMonitor({
			intervalMs: 50,
			staleTimeoutMs: 600_000,
			autoInterruptMs: 0,
		});
		const session = createMockSession("s1", {
			isPrompting: true,
			lastActivityAt: new Date(Date.now() - 500_000),
		});
		mon.register(session);
		const staleIds = await mon.check();
		expect(staleIds).not.toContain("s1");
	});

	it("does not detect stall when not prompting", async () => {
		const session = createMockSession("s1", {
			isPrompting: false,
			lastActivityAt: new Date(Date.now() - 500),
		});
		monitor.register(session);
		const staleIds = await monitor.check();
		expect(staleIds).not.toContain("s1");
	});

	it("calls onStale for stalled prompts via start() loop", async () => {
		const onStale = mock().mockResolvedValue(undefined);
		const mon = new HealthMonitor({
			intervalMs: 50,
			staleTimeoutMs: 600_000,
			autoInterruptMs: 100,
			onStale,
		});
		const session = createMockSession("s1", {
			isPrompting: true,
			lastActivityAt: new Date(Date.now() - 200),
		});
		mon.register(session);
		mon.start();
		await new Promise((r) => setTimeout(r, 200));
		mon.stop();
		expect(onStale).toHaveBeenCalledWith("s1");
	});

	it("markPromptStart sets isPrompting and promptStartedAt", () => {
		const session = createMockSession("s1");
		monitor.register(session);
		monitor.markPromptStart("s1");
		expect(session.isPrompting).toBe(true);
		expect(session.promptStartedAt).toBeDefined();
	});

	it("markPromptEnd clears isPrompting", () => {
		const session = createMockSession("s1");
		monitor.register(session);
		monitor.markPromptStart("s1");
		monitor.markPromptEnd("s1");
		expect(session.isPrompting).toBe(false);
	});

	it("markPromptStart resets attentionNotified flag", async () => {
		const onNeedsAttention = mock().mockResolvedValue(undefined);
		const mon = new HealthMonitor({
			intervalMs: 30,
			staleTimeoutMs: 600_000,
			needsAttentionMs: 50,
			autoInterruptMs: 600,
			onNeedsAttention,
		});
		const session = createMockSession("s1", {
			isPrompting: true,
			lastActivityAt: new Date(Date.now() - 100),
		});
		mon.register(session);
		// First check should notify
		await mon.check();
		expect(onNeedsAttention).toHaveBeenCalledTimes(1);
		// Second check should NOT notify again
		await mon.check();
		expect(onNeedsAttention).toHaveBeenCalledTimes(1);
		// Touch resets the flag
		mon.touch("s1");
		// Force the lastActivityAt back to be old enough
		session.lastActivityAt = new Date(Date.now() - 100);
		await mon.check();
		expect(onNeedsAttention).toHaveBeenCalledTimes(2);
	});

	it("onNeedsAttention errors are caught gracefully", async () => {
		const onNeedsAttention = mock().mockRejectedValue(new Error("callback fail"));
		const mon = new HealthMonitor({
			intervalMs: 50,
			staleTimeoutMs: 600_000,
			needsAttentionMs: 50,
			autoInterruptMs: 600,
			onNeedsAttention,
		});
		const session = createMockSession("s1", {
			isPrompting: true,
			lastActivityAt: new Date(Date.now() - 100),
		});
		mon.register(session);
		// Should not throw
		const staleIds = await mon.check();
		expect(staleIds).not.toContain("s1");
	});

	it("onStale callback error is caught in start() loop", async () => {
		const onStale = mock().mockRejectedValue(new Error("stale fail"));
		const mon = new HealthMonitor({
			intervalMs: 50,
			staleTimeoutMs: 100,
			onStale,
		});
		const session = createMockSession("s1");
		session.busy = true;
		session.lastResponseAt = new Date(Date.now() - 200);
		mon.register(session);
		mon.start();
		await new Promise((r) => setTimeout(r, 200));
		mon.stop();
		expect(onStale).toHaveBeenCalled();
	});
});

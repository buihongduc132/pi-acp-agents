/**
 * Additional branch coverage for circuit-breaker.ts
 * Targets: concurrent half-open probe, killWithEscalation edge cases
 */
import { describe, it, expect, vi } from "vitest";
import { AcpCircuitBreaker, CircuitHalfOpenError, CircuitOpenError, killWithEscalation } from "../src/core/circuit-breaker.js";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

describe("AcpCircuitBreaker — additional branch coverage", () => {
	describe("concurrent half-open probe (EC-46)", () => {
		it("throws CircuitHalfOpenError when probe already in progress", async () => {
			const cb = new AcpCircuitBreaker(1, 10);
			// Open the circuit
			await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
			expect(cb.state).toBe("open");

			// Wait for reset timeout so it transitions to half-open
			await new Promise((r) => setTimeout(r, 20));

			// Start first probe (don't await yet)
			const probe1 = cb.execute(async () => {
				await new Promise((r) => setTimeout(r, 200));
				return "probe1";
			});

			// Second probe should get CircuitHalfOpenError
			await expect(cb.execute(async () => "probe2")).rejects.toThrow(CircuitHalfOpenError);

			// First probe should still complete
			const result = await probe1;
			expect(result).toBe("probe1");
		});
	});

	describe("execute with custom timeoutMs", () => {
		it("uses provided timeoutMs instead of default stallTimeoutMs", async () => {
			const cb = new AcpCircuitBreaker(3, 60_000, 60_000);
			await expect(
				cb.execute(
					async () => {
						await new Promise((r) => setTimeout(r, 10_000));
						return "late";
					},
					{ timeoutMs: 30 },
				),
			).rejects.toThrow("Operation stalled");
		});
	});

	describe("executeWithStallTimeout — cancel succeeds", () => {
		it("returns result when fn completes and onCancel succeeds", async () => {
			const cb = new AcpCircuitBreaker();
			const result = await cb.executeWithStallTimeout(
				async () => "done",
				{ stallTimeoutMs: 5000, onCancel: async () => {} },
			);
			expect(result.result).toBe("done");
			expect(result.stalled).toBe(false);
		});

		it("returns error when fn throws", async () => {
			const cb = new AcpCircuitBreaker();
			const result = await cb.executeWithStallTimeout(
				async () => { throw new Error("boom"); },
				{ stallTimeoutMs: 5000, onCancel: async () => {} },
			);
			expect(result.stalled).toBe(false);
			expect(result.error).toBeInstanceOf(Error);
			expect((result.error as Error).message).toBe("boom");
		});
	});
});

describe("killWithEscalation", () => {
	it("does nothing if proc is already killed", () => {
		const proc = new EventEmitter() as any;
		proc.killed = true;
		proc.kill = vi.fn();
		killWithEscalation(proc);
		expect(proc.kill).not.toHaveBeenCalled();
	});

	it("sends SIGTERM then SIGKILL after timeout", async () => {
		const proc = new EventEmitter() as any;
		proc.killed = false;
		proc.kill = vi.fn(() => {
			// First SIGTERM doesn't kill, but SIGKILL does
			if (proc.kill.mock.calls.length > 1) {
				proc.killed = true;
			}
		});
		killWithEscalation(proc, 50);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		// Wait for escalation
		await new Promise((r) => setTimeout(r, 100));
		expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("catches SIGTERM error when already dead", () => {
		const proc = new EventEmitter() as any;
		proc.killed = false;
		proc.kill = vi.fn(() => { throw new Error("already dead"); });
		expect(() => killWithEscalation(proc)).not.toThrow();
	});

	it("catches SIGKILL error when already dead", async () => {
		const proc = new EventEmitter() as any;
		let killCallCount = 0;
		proc.killed = false;
		proc.kill = vi.fn((signal: string) => {
			killCallCount++;
			if (signal === "SIGKILL") {
				throw new Error("already dead");
			}
		});
		killWithEscalation(proc, 50);
		await new Promise((r) => setTimeout(r, 100));
		// SIGKILL error was caught, no throw
		expect(killCallCount).toBe(2);
	});
});

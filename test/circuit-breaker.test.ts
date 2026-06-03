import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AcpCircuitBreaker, CircuitOpenError } from "../src/core/circuit-breaker.js";

describe("AcpCircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new AcpCircuitBreaker();
    expect(cb.state).toBe("closed");
  });

  it("stays closed on success", async () => {
    const cb = new AcpCircuitBreaker(3, 1000);
    await cb.execute(async () => "ok");
    expect(cb.state).toBe("closed");
  });

  it("opens after maxFailures consecutive failures", async () => {
    const cb = new AcpCircuitBreaker(2, 60_000);
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    }
    expect(cb.state).toBe("open");
  });

  it("throws CircuitOpenError when open", async () => {
    const cb = new AcpCircuitBreaker(1, 60_000);
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    await expect(cb.execute(async () => "ok")).rejects.toThrow(CircuitOpenError);
  });

  it("transitions to half-open after reset timeout", async () => {
    const cb = new AcpCircuitBreaker(1, 10);
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    expect(cb.state).toBe("open");
    await new Promise((r) => setTimeout(r, 20));
    const result = await cb.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(cb.state).toBe("closed");
  });

  it("re-opens if half-open attempt fails", async () => {
    const cb = new AcpCircuitBreaker(1, 10);
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    await expect(cb.execute(async () => { throw new Error("fail again"); })).rejects.toThrow();
    expect(cb.state).toBe("open");
  });

  it("resets failure count on success", async () => {
    const cb = new AcpCircuitBreaker(2, 60_000);
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    await cb.execute(async () => "ok");
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    expect(cb.state).toBe("closed");
  });

  it("executes fn and returns its result", async () => {
    const cb = new AcpCircuitBreaker();
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
  });

  describe("stall timeout", () => {
    it("returns stalled result when fn takes too long", async () => {
      const cb = new AcpCircuitBreaker();
      const result = await cb.executeWithStallTimeout(
        async () => { await new Promise((r) => setTimeout(r, 10_000)); return "late"; },
        { stallTimeoutMs: 50, onCancel: async () => {} },
      );
      expect(result.stalled).toBe(true);
    });

    it("still resolves stalled when onCancel throws", async () => {
      const cb = new AcpCircuitBreaker();
      const result = await cb.executeWithStallTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return "late";
        },
        {
          stallTimeoutMs: 20,
          onCancel: async () => {
            throw new Error("cancel failed");
          },
        },
      );
      expect(result.stalled).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("marks execute as stalled when onCancel throws", async () => {
      const cb = new AcpCircuitBreaker(3, 60_000, 20);
      await expect(
        cb.execute(async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return "late";
        }),
      ).rejects.toThrow("Operation stalled after 20ms");
    });

    it("returns result when fn completes in time", async () => {
      const cb = new AcpCircuitBreaker();
      const result = await cb.executeWithStallTimeout(
        async () => "fast",
        { stallTimeoutMs: 5000, onCancel: async () => {} },
      );
      expect(result.result).toBe("fast");
      expect(result.stalled).toBe(false);
    });
  });
});

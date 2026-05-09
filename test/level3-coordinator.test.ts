import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCoordinator } from "../src/coordination/coordinator.js";
import type { AcpConfig } from "../src/config/types.js";
import { createAdapter } from "../src/adapter-factory.js";

// Mock the adapter factory
vi.mock("../src/adapter-factory.js");

const mockPromptResult = {
  text: "mock response",
  stopReason: "end_turn" as const,
  sessionId: "mock-session-id",
};

function createMockAdapter(overrides: Record<string, any> = {}) {
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue("mock-session-id"),
    prompt: vi.fn().mockResolvedValue({ ...mockPromptResult }),
    loadSession: vi.fn().mockResolvedValue("mock-session-id"),
    setModel: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    connected: true,
    ...overrides,
  };
}

const mockConfig: AcpConfig = {
  agent_servers: {
    gemini: { command: "gemini", args: ["--acp"] },
    claude: { command: "claude", args: ["--acp"] },
  },
  defaultAgent: "gemini",
  staleTimeoutMs: 3_600_000,
  healthCheckIntervalMs: 30_000,
  circuitBreakerMaxFailures: 3,
  circuitBreakerResetMs: 60_000,
};

describe("AgentCoordinator", () => {
  let coordinator: AgentCoordinator;

  beforeEach(() => {
    vi.mocked(createAdapter).mockReturnValue(createMockAdapter() as any);
    coordinator = new AgentCoordinator(mockConfig, "/tmp");
  });

  describe("delegate", () => {
    it("delegates a task to a single agent", async () => {
      const result = await coordinator.delegate("gemini", "Say hello");
      expect(result.text).toBe("mock response");
      expect(result.stopReason).toBe("end_turn");
      expect(result.sessionId).toBe("mock-session-id");
    });

    it("throws if agent not found", async () => {
      await expect(coordinator.delegate("nonexistent", "test")).rejects.toThrow(
        'Agent "nonexistent" not found',
      );
    });

    it("creates adapter with correct cwd", async () => {
      await coordinator.delegate("gemini", "test", "/custom/path");
      expect(createAdapter).toHaveBeenCalledWith(
        "gemini",
        expect.anything(),
        expect.anything(),
        "/custom/path",
      );
    });

    it("disposes adapter after use", async () => {
      const adapter = createMockAdapter();
      vi.mocked(createAdapter).mockReturnValue(adapter as any);
      await coordinator.delegate("gemini", "test");
      expect(adapter.dispose).toHaveBeenCalled();
    });

    it("disposes adapter even on error", async () => {
      const adapter = createMockAdapter({
        prompt: vi.fn().mockRejectedValue(new Error("boom")),
      });
      vi.mocked(createAdapter).mockReturnValue(adapter as any);
      await expect(coordinator.delegate("gemini", "test")).rejects.toThrow("boom");
      expect(adapter.dispose).toHaveBeenCalled();
    });
  });

  describe("broadcast", () => {
    it("sends prompt to multiple agents in parallel", async () => {
      const results = await coordinator.broadcast(["gemini", "claude"], "Say hi");
      expect(results).toHaveLength(2);
      expect(results[0].agent).toBe("gemini");
      expect(results[1].agent).toBe("claude");
      expect(results[0].text).toBe("mock response");
    });

    it("handles individual agent failures gracefully", async () => {
      let callCount = 0;
      vi.mocked(createAdapter).mockImplementation((() => {
        callCount++;
        if (callCount === 2) {
          return createMockAdapter({
            prompt: vi.fn().mockRejectedValue(new Error("agent crashed")),
          }) as any;
        }
        return createMockAdapter() as any;
      }) as any);

      const results = await coordinator.broadcast(["gemini", "claude"], "test");
      expect(results).toHaveLength(2);
      // At least one should have succeeded
      const successes = results.filter((r) => !r.error);
      expect(successes.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty for empty agent list", async () => {
      const results = await coordinator.broadcast([], "test");
      expect(results).toHaveLength(0);
    });
  });

  describe("compare", () => {
    it("returns structured comparison", async () => {
      const result = await coordinator.compare(["gemini", "claude"], "Compare test");
      expect(result.prompt).toBe("Compare test");
      expect(result.responses).toHaveLength(2);
      expect(result.timestamp).toBeTruthy();
    });

    it("includes error info in comparison", async () => {
      let callCount = 0;
      vi.mocked(createAdapter).mockImplementation((() => {
        callCount++;
        if (callCount === 2) {
          return createMockAdapter({
            prompt: vi.fn().mockRejectedValue(new Error("fail")),
          }) as any;
        }
        return createMockAdapter() as any;
      }) as any);

      const result = await coordinator.compare(["gemini", "claude"], "test");
      expect(result.responses).toHaveLength(2);
      const errors = result.responses.filter((r) => r.error);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("formatComparison", () => {
    it("formats comparison as readable text", () => {
      const comparison = {
        prompt: "test prompt",
        responses: [
          { agent: "gemini", text: "hello from gemini", sessionId: "s1", stopReason: "end_turn" },
          { agent: "claude", text: "hello from claude", sessionId: "s2", stopReason: "end_turn" },
        ],
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      const formatted = coordinator.formatComparison(comparison);
      expect(formatted).toContain("ACP Agent Comparison");
      expect(formatted).toContain("gemini");
      expect(formatted).toContain("claude");
      expect(formatted).toContain("hello from gemini");
      expect(formatted).toContain("hello from claude");
    });

    it("shows errors in formatted output", () => {
      const comparison = {
        prompt: "test",
        responses: [
          { agent: "gemini", text: "", sessionId: "", stopReason: "error", error: "timeout" },
        ],
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      const formatted = coordinator.formatComparison(comparison);
      expect(formatted).toContain("(ERROR)");
      expect(formatted).toContain("timeout");
    });
  });
});

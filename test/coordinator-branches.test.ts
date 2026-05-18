/**
 * Branch coverage for coordinator.ts — broadcast, compare, formatComparison
 * Covers the rejected promise path and error formatting branches
 */
import { describe, it, expect, vi } from "vitest";
import { AgentCoordinator } from "../src/coordination/coordinator.js";
import type { AcpConfig } from "../src/config/types.js";

// Mock adapter-factory
vi.mock("../src/adapter-factory.js", () => ({
	createAdapter: vi.fn(),
}));

import { createAdapter } from "../src/adapter-factory.js";

function makeMockAdapter(result: Record<string, any> = {}) {
	return {
		spawn: vi.fn().mockResolvedValue(undefined),
		initialize: vi.fn().mockResolvedValue(undefined),
		newSession: vi.fn().mockResolvedValue("session-1"),
		prompt: vi.fn().mockResolvedValue({
			text: "response",
			stopReason: "end_turn",
			sessionId: "session-1",
			...result,
		}),
		dispose: vi.fn(),
		connected: true,
	};
}

function makeFailingAdapter(error: Error) {
	return {
		spawn: vi.fn().mockRejectedValue(error),
		initialize: vi.fn(),
		newSession: vi.fn(),
		prompt: vi.fn(),
		dispose: vi.fn(),
		connected: false,
	};
}

const mockConfig: AcpConfig = {
	agent_servers: {
		gemini: { command: "gemini", args: ["--acp"] },
		claude: { command: "claude", args: ["--acp"] },
		codex: { command: "codex-acp", args: [] },
	},
	defaultAgent: "gemini",
};

describe("AgentCoordinator — broadcast/compare branches", () => {
	it("broadcast returns results from all agents", async () => {
		vi.mocked(createAdapter).mockReturnValue(makeMockAdapter() as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const results = await coordinator.broadcast(["gemini", "claude"], "hello");
		expect(results).toHaveLength(2);
		expect(results[0].agent).toBe("gemini");
		expect(results[1].agent).toBe("claude");
	});

	it("broadcast handles partial failure — one agent fails", async () => {
		vi.mocked(createAdapter)
			.mockReturnValueOnce(makeMockAdapter() as any)
			.mockReturnValueOnce(makeFailingAdapter(new Error("spawn failed")) as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const results = await coordinator.broadcast(["gemini", "claude"], "hello");
		expect(results).toHaveLength(2);
		// First succeeds
		expect(results[0].agent).toBe("gemini");
		expect(results[0].error).toBeUndefined();
		// Second fails — handled in catch
		expect(results[1].agent).toBe("claude");
		expect(results[1].error).toBe("spawn failed");
		expect(results[1].stopReason).toBe("error");
	});

	it("broadcast handles non-Error throws", async () => {
		vi.mocked(createAdapter).mockReturnValue(makeFailingAdapter("string error" as any) as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const results = await coordinator.broadcast(["gemini"], "hello");
		expect(results[0].error).toBe("string error");
	});

	it("compare returns structured comparison", async () => {
		vi.mocked(createAdapter).mockReturnValue(makeMockAdapter() as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const comparison = await coordinator.compare(["gemini", "claude"], "test prompt");
		expect(comparison.prompt).toBe("test prompt");
		expect(comparison.responses).toHaveLength(2);
		expect(comparison.timestamp).toBeTruthy();
	});

	it("formatComparison with error responses", () => {
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const formatted = coordinator.formatComparison({
			prompt: "test",
			responses: [
				{ agent: "gemini", text: "hello", stopReason: "end_turn" },
				{ agent: "claude", error: "failed" },
			],
			timestamp: "2025-01-01T00:00:00Z",
		});
		expect(formatted).toContain("hello");
		expect(formatted).toContain("(ERROR) failed");
		expect(formatted).toContain("test");
	});

	it("formatComparison with no text response", () => {
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const formatted = coordinator.formatComparison({
			prompt: "test",
			responses: [
				{ agent: "gemini", stopReason: "end_turn" },
			],
			timestamp: "2025-01-01T00:00:00Z",
		});
		expect(formatted).toContain("(no response)");
	});

	it("delegate throws for unknown agent", async () => {
		vi.mocked(createAdapter).mockReturnValue(makeMockAdapter() as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		await expect(coordinator.delegate("unknown", "hello")).rejects.toThrow('Agent "unknown" not found');
	});

	it("delegate resolves with default agent", async () => {
		vi.mocked(createAdapter).mockReturnValue(makeMockAdapter() as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const result = await coordinator.delegate("gemini", "hello");
		expect(result.text).toBe("response");
		expect(result.stopReason).toBe("end_turn");
	});
});

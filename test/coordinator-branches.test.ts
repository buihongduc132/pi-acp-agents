/**
 * Branch coverage for coordinator.ts — broadcast, compare, formatComparison
 * Covers the rejected promise path and error formatting branches
 */
import { describe, it, expect, mock } from "bun:test";
import { AgentCoordinator } from "../src/coordination/coordinator.js";
import type { AcpConfig } from "../src/config/types.js";

// Mock adapter-factory
const mockCreateAdapter = mock();
mock.module("../src/adapter-factory.js", () => ({
	createAdapter: mockCreateAdapter,
}));

function makeMockAdapter(result: Record<string, any> = {}) {
	return {
		spawn: mock().mockResolvedValue(undefined),
		initialize: mock().mockResolvedValue(undefined),
		newSession: mock().mockResolvedValue("session-1"),
		prompt: mock().mockResolvedValue({
			text: "response",
			stopReason: "end_turn",
			sessionId: "session-1",
			...result,
		}),
		dispose: mock(),
		connected: true,
	};
}

function makeFailingAdapter(error: Error) {
	return {
		spawn: mock().mockRejectedValue(error),
		initialize: mock(),
		newSession: mock(),
		prompt: mock(),
		dispose: mock(),
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
		mockCreateAdapter.mockReturnValue(makeMockAdapter() as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const results = await coordinator.broadcast(["gemini", "claude"], "hello");
		expect(results).toHaveLength(2);
		expect(results[0].agent).toBe("gemini");
		expect(results[1].agent).toBe("claude");
	});

	it("broadcast handles partial failure — one agent fails", async () => {
		mockCreateAdapter
			.mockReturnValueOnce(makeMockAdapter() as any)
			.mockReturnValueOnce(makeFailingAdapter(new Error("spawn failed")) as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const results = await coordinator.broadcast(["gemini", "claude"], "hello");
		expect(results).toHaveLength(2);
		expect(results[0].agent).toBe("gemini");
		expect(results[0].error).toBeUndefined();
		expect(results[1].agent).toBe("claude");
		expect(results[1].error).toBe("spawn failed");
		expect(results[1].stopReason).toBe("error");
	});

	it("broadcast handles non-Error throws", async () => {
		mockCreateAdapter.mockReturnValue(makeFailingAdapter("string error" as any) as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const results = await coordinator.broadcast(["gemini"], "hello");
		expect(results[0].error).toBe("string error");
	});

	it("compare returns structured comparison", async () => {
		mockCreateAdapter.mockReturnValue(makeMockAdapter() as any);
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
		mockCreateAdapter.mockReturnValue(makeMockAdapter() as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		await expect(coordinator.delegate("unknown", "hello")).rejects.toThrow('Agent "unknown" not found');
	});

	it("delegate resolves with default agent", async () => {
		mockCreateAdapter.mockReturnValue(makeMockAdapter() as any);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");
		const result = await coordinator.delegate("gemini", "hello");
		expect(result.text).toBe("response");
		expect(result.stopReason).toBe("end_turn");
	});
});

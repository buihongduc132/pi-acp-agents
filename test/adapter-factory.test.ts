/**
 * RED tests for adapter-factory module.
 */
import { describe, it, expect } from "vitest";
import { createAdapter } from "../src/adapter-factory.js";
import { GeminiAcpAdapter } from "../src/adapters/gemini.js";
import { CustomAcpAdapter } from "../src/adapters/custom.js";
import type { AcpConfig } from "../src/config/types.js";

function createTestConfig(): AcpConfig {
	return {
		agents: {
			gemini: { command: "gemini", args: ["--acp"] },
			custom: { command: "my-agent", args: ["--mode", "acp"] },
		},
		defaultAgent: "gemini",
		logsDir: "/tmp/test-logs",
	};
}

describe("createAdapter", () => {
	it("creates GeminiAcpAdapter for 'gemini' agent name", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"gemini",
			config.agents.gemini,
			config,
		);
		expect(adapter).toBeInstanceOf(GeminiAcpAdapter);
		expect(adapter.name).toBe("gemini");
	});

	it("creates CustomAcpAdapter for unknown agent name", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"custom",
			config.agents.custom,
			config,
		);
		expect(adapter).toBeInstanceOf(CustomAcpAdapter);
	});

	it("creates CustomAcpAdapter for any non-gemini name", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"my-random-agent",
			{ command: "some-binary" },
			config,
		);
		expect(adapter).toBeInstanceOf(CustomAcpAdapter);
	});
});

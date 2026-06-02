/**
 * RED tests for adapter-factory module.
 */
import { describe, it, expect } from "vitest";
import { createAdapter, isKnownAdapter } from "../src/adapter-factory.js";
import { CodexAcpAdapter } from "../src/adapters/codex.js";
import { CustomAcpAdapter } from "../src/adapters/custom.js";
import { GeminiAcpAdapter } from "../src/adapters/gemini.js";
import { OpenCodeAcpAdapter } from "../src/adapters/opencode.js";
import { AcpxAdapter } from "../src/adapters/acpx.js";
import type { AcpConfig } from "../src/config/types.js";

function createTestConfig(): AcpConfig {
	return {
		agent_servers: {
			gemini: { command: "gemini", args: ["--acp"] },
			opencode: { command: "ocxo", args: ["acp"] },
			codex: { command: "codex-acp", args: [] },
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
			config.agent_servers.gemini,
			config,
		);
		expect(adapter).toBeInstanceOf(GeminiAcpAdapter);
		expect(adapter.name).toBe("gemini");
	});

	it("passes cwd through for gemini adapters", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"gemini",
			config.agent_servers.gemini,
			config,
			"/tmp/gemini-cwd",
		);
		expect((adapter as any).cwd).toBe("/tmp/gemini-cwd");
	});

	it("creates CustomAcpAdapter for unknown agent name", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"custom",
			config.agent_servers.custom,
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

	it("creates OpenCodeAcpAdapter for 'opencode' agent name", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"opencode",
			config.agent_servers.opencode,
			config,
		);
		expect(adapter).toBeInstanceOf(OpenCodeAcpAdapter);
		expect(adapter.name).toBe("opencode");
	});

	it("creates CodexAcpAdapter for 'codex' agent name", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"codex",
			config.agent_servers.codex,
			config,
		);
		expect(adapter).toBeInstanceOf(CodexAcpAdapter);
		expect(adapter.name).toBe("codex");
	});

	it("passes cwd through for opencode adapters", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"opencode",
			config.agent_servers.opencode,
			config,
			"/tmp/opencode-cwd",
		);
		expect((adapter as any).cwd).toBe("/tmp/opencode-cwd");
	});

	it("isKnownAdapter returns true for gemini/opencode/codex", () => {
		expect(isKnownAdapter("gemini")).toBe(true);
		expect(isKnownAdapter("opencode")).toBe(true);
		expect(isKnownAdapter("codex")).toBe(true);
		expect(isKnownAdapter("unknown")).toBe(false);
	});

	// --- T9: Mode-based routing ---

	it("creates AcpxAdapter when mode is 'acpx' even for known adapter names", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"gemini",
			{ ...config.agent_servers.gemini, mode: "acpx" },
			config,
		);
		expect(adapter).toBeInstanceOf(AcpxAdapter);
		expect(adapter.name).toBe("acpx");
	});

	it("creates AcpxAdapter for unknown agent with mode 'acpx'", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"my-acpx-agent",
			{ mode: "acpx" },
			config,
		);
		expect(adapter).toBeInstanceOf(AcpxAdapter);
	});

	it("defaults to direct adapter when mode is omitted", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"custom",
			{ command: "some-agent" },
			config,
		);
		expect(adapter).toBeInstanceOf(CustomAcpAdapter);
		expect(adapter).not.toBeInstanceOf(AcpxAdapter);
	});

	it("passes agentName to AcpxAdapter for session creation", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"claude-sonnet",
			{ mode: "acpx" },
			config,
		);
		expect(adapter).toBeInstanceOf(AcpxAdapter);
		// The adapter should have received the agent name for acpx session creation
		expect((adapter as any).config.agentName).toBe("claude-sonnet");
	});

	it("creates GeminiAcpAdapter when mode is explicitly 'direct'", () => {
		const config = createTestConfig();
		const adapter = createAdapter(
			"gemini",
			{ ...config.agent_servers.gemini, mode: "direct" },
			config,
		);
		expect(adapter).toBeInstanceOf(GeminiAcpAdapter);
	});
});

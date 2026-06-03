/**
 * RED tests for adapter-factory module.
 */
import { describe, it, expect } from "bun:test";
import { createAdapter, isKnownAdapter } from "../src/adapter-factory.js";
import { AcpxAdapter } from "../src/adapters/acpx.js";
import { CodexAcpAdapter } from "../src/adapters/codex.js";
import { CustomAcpAdapter } from "../src/adapters/custom.js";
import { GeminiAcpAdapter } from "../src/adapters/gemini.js";
import { OpenCodeAcpAdapter } from "../src/adapters/opencode.js";
import type { AcpAgentConfig, AcpConfig } from "../src/config/types.js";

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
});

describe("createAdapter — mode routing", () => {
	const baseConfig: AcpConfig = {
		agent_servers: {
			gemini: { command: "gemini", args: ["--acp"] },
			"my-acpx-agent": { command: "acpx", mode: "acpx" as const },
			"my-direct-agent": { command: "my-cli", mode: "direct" as const },
		},
		defaultAgent: "gemini",
	};

	it("routes to AcpxAdapter when mode is 'acpx' (overrides name-based routing)", () => {
		const adapter = createAdapter(
			"gemini",
			{ ...baseConfig.agent_servers.gemini, mode: "acpx" },
			baseConfig,
		);
		expect(adapter).toBeInstanceOf(AcpxAdapter);
		expect(adapter.name).toBe("acpx");
	});

	it("routes to AcpxAdapter for unknown agent name when mode is 'acpx'", () => {
		const cfg: AcpAgentConfig = { command: "acpx", mode: "acpx" };
		const adapter = createAdapter("some-unknown-agent", cfg, baseConfig);
		expect(adapter).toBeInstanceOf(AcpxAdapter);
	});

	it("routes to name-based adapter when mode is 'direct'", () => {
		const cfg: AcpAgentConfig = { command: "my-cli", mode: "direct" };
		const adapter = createAdapter("gemini", cfg, baseConfig);
		expect(adapter).toBeInstanceOf(GeminiAcpAdapter);
	});

	it("routes to CustomAcpAdapter for unknown name when mode is 'direct'", () => {
		const cfg: AcpAgentConfig = { command: "my-cli", mode: "direct" };
		const adapter = createAdapter("unknown-agent", cfg, baseConfig);
		expect(adapter).toBeInstanceOf(CustomAcpAdapter);
	});

	it("defaults to name-based routing when mode is undefined", () => {
		const cfg: AcpAgentConfig = { command: "gemini", args: ["--acp"] };
		const adapter = createAdapter("gemini", cfg, baseConfig);
		expect(adapter).toBeInstanceOf(GeminiAcpAdapter);
	});

	it("passes agentName to AcpxAdapter for session creation", () => {
		const cfg: AcpAgentConfig = { command: "acpx", mode: "acpx" };
		const adapter = createAdapter("my-special-agent", cfg, baseConfig);
		expect(adapter).toBeInstanceOf(AcpxAdapter);
		expect((adapter as any).agentName).toBe("my-special-agent");
	});
});

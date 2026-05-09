/**
 * pi-acp-agents — Adapter factory
 */

import type { AcpAgentAdapter } from "./adapters/base.js";
import { CodexAcpAdapter } from "./adapters/codex.js";
import { CustomAcpAdapter } from "./adapters/custom.js";
import { GeminiAcpAdapter } from "./adapters/gemini.js";
import { OpenCodeAcpAdapter } from "./adapters/opencode.js";
import type { AcpAgentConfig, AcpConfig } from "./config/types.js";

/** Known adapter names that map to dedicated adapter classes */
const KNOWN_ADAPTERS = new Set(["gemini", "opencode", "codex"]);

export function createAdapter(
	agentName: string,
	agentConfig: AcpAgentConfig,
	_globalConfig: AcpConfig,
	cwd?: string,
): AcpAgentAdapter {
	switch (agentName) {
		case "gemini":
			return new GeminiAcpAdapter({ config: agentConfig, cwd });
		case "opencode":
			return new OpenCodeAcpAdapter({ config: agentConfig, cwd });
		case "codex":
			return new CodexAcpAdapter({ config: agentConfig, cwd });
		default:
			return new CustomAcpAdapter({
				config: agentConfig,
				agentName,
				cwd,
			});
	}
}

/** Check if an agent name has a dedicated adapter */
export function isKnownAdapter(name: string): boolean {
	return KNOWN_ADAPTERS.has(name);
}

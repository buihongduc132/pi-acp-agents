/**
 * pi-acp-agents — Adapter factory
 */

import type { AcpAgentAdapter } from "./adapters/base.js";
import { CustomAcpAdapter } from "./adapters/custom.js";
import { GeminiAcpAdapter } from "./adapters/gemini.js";
import type { AcpAgentConfig, AcpConfig } from "./config/types.js";

export function createAdapter(
	agentName: string,
	agentConfig: AcpAgentConfig,
	_globalConfig: AcpConfig,
	cwd?: string,
): AcpAgentAdapter {
	switch (agentName) {
		case "gemini":
			return new GeminiAcpAdapter({ config: agentConfig });
		default:
			return new CustomAcpAdapter({
				config: agentConfig,
				agentName,
				cwd,
			});
	}
}

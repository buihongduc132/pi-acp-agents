/**
 * pi-acp-agents — Adapter factory
 *
 * Routes adapter creation based on agent config:
 * - mode === 'acpx' → AcpxAdapter (CLI delegation)
 * - mode === 'direct' or undefined → dedicated adapter (gemini/opencode/codex) or CustomAcpAdapter
 */

import type { AcpAgentAdapter } from "./adapters/base.js";
import { AcpxAdapter } from "./adapters/acpx.js";
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
	adapterOpts?: { onActivity?: (sessionId: string) => void },
): AcpAgentAdapter {
	const sharedOpts = { onActivity: adapterOpts?.onActivity };

	// ACPX mode: delegate to acpx CLI
	if (agentConfig.mode === "acpx") {
		return new AcpxAdapter({
			config: { ...agentConfig, agentName: agentConfig.agentName ?? agentName },
			cwd,
			agentName,
			...sharedOpts,
		});
	}

	// Direct mode (or default): use dedicated adapter or fallback to custom
	switch (agentName) {
		case "gemini":
			return new GeminiAcpAdapter({ config: agentConfig, cwd, ...sharedOpts });
		case "opencode":
			return new OpenCodeAcpAdapter({ config: agentConfig, cwd, ...sharedOpts });
		case "codex":
			return new CodexAcpAdapter({ config: agentConfig, cwd, ...sharedOpts });
		default:
			return new CustomAcpAdapter({
				config: agentConfig,
				agentName,
				cwd,
				...sharedOpts,
			});
	}
}

/** Check if an agent name has a dedicated adapter */
export function isKnownAdapter(name: string): boolean {
	return KNOWN_ADAPTERS.has(name);
}

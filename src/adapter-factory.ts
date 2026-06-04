/**
 * pi-acp-agents — Adapter factory with mode-based routing.
 *
 * Routing priority:
 * 1. mode === 'acpx' → AcpxAdapter (CLI delegation)
 * 2. mode === 'direct' or undefined → name-based routing to dedicated adapters
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

	// Mode-based routing: acpx mode always routes to AcpxAdapter
	if (agentConfig.mode === "acpx") {
		return new AcpxAdapter({ config: agentConfig, cwd, agentName, ...sharedOpts }) as unknown as AcpAgentAdapter;
	}

	// Direct mode (or undefined/default) → name-based routing
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

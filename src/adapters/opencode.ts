/**
 * pi-acp-agents — OpenCode ACP adapter
 *
 * Protocol: stdio nd-JSON, standard ACP.
 * Command: `opencode acp` (or `ocxo acp` when installed via alias)
 *
 * No provider-specific features — pure ACP protocol compliance.
 */
import { AcpAgentAdapter } from "./base.js";
import type { AcpAgentConfig } from "../config/types.js";
import type { Logger } from "../logger.js";
import { execSync } from "node:child_process";

export interface OpenCodeAdapterOptions {
	config?: Partial<AcpAgentConfig>;
	clientInfo?: { name: string; version: string };
	logger?: Logger;
	cwd?: string;
}

export class OpenCodeAcpAdapter extends AcpAgentAdapter {
	constructor(opts: Partial<OpenCodeAdapterOptions> = {}) {
		// Auto-resolve binary: prefer explicit config, then ocxo, then opencode
		const resolvedBinary = opts.config?.command || OpenCodeAcpAdapter.resolveBinary() || "opencode";
		super({
			config: {
				command: resolvedBinary,
				args: ["acp"],
				...opts.config,
			} as AcpAgentConfig,
			clientInfo: opts.clientInfo,
			logger: opts.logger,
			cwd: opts.cwd,
		});
	}

	get name(): string {
		return "opencode";
	}

	protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
		return {
			...config,
			command: config.command || "opencode",
			args: config.args ?? ["acp"],
		};
	}

	/** Check if opencode CLI is available (checks opencode, ocxo) */
	static isAvailable(binary?: string): boolean {
		const candidates = binary ? [binary] : ["opencode", "ocxo"];
		for (const cmd of candidates) {
			try {
				execSync(`which ${cmd}`, { stdio: "pipe" });
				return true;
			} catch {
				continue;
			}
		}
		return false;
	}

	/** Get CLI version */
	static getVersion(binary?: string): string | null {
		const candidates = binary ? [binary] : ["opencode", "ocxo"];
		for (const cmd of candidates) {
			try {
				const output = execSync(`${cmd} --version`, {
					encoding: "utf-8",
					stdio: "pipe",
				});
				return `${cmd}: ${output.trim()}`;
			} catch {
				continue;
			}
		}
		return null;
	}

	/** Resolve the actual binary name to use */
	static resolveBinary(): string | null {
		for (const cmd of ["opencode", "ocxo"]) {
			try {
				execSync(`which ${cmd}`, { stdio: "pipe" });
				return cmd;
			} catch {
				continue;
			}
		}
		return null;
	}
}

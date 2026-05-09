/**
 * pi-acp-agents — Codex ACP adapter
 *
 * Protocol: stdio nd-JSON, standard ACP.
 * Uses the third-party codex-acp bridge (cola-io/codex-acp) which wraps
 * the OpenAI Codex runtime with ACP protocol.
 *
 * No provider-specific features — pure ACP protocol compliance.
 */
import { AcpAgentAdapter } from "./base.js";
import type { AcpAgentConfig } from "../config/types.js";
import type { Logger } from "../logger.js";
import { execSync } from "node:child_process";

export interface CodexAdapterOptions {
	config?: Partial<AcpAgentConfig>;
	clientInfo?: { name: string; version: string };
	logger?: Logger;
	cwd?: string;
}

export class CodexAcpAdapter extends AcpAgentAdapter {
	constructor(opts: Partial<CodexAdapterOptions> = {}) {
		super({
			config: {
				command: "codex-acp",
				args: [],
				...opts.config,
			} as AcpAgentConfig,
			clientInfo: opts.clientInfo,
			logger: opts.logger,
			cwd: opts.cwd,
		});
	}

	get name(): string {
		return "codex";
	}

	protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
		return {
			...config,
			command: config.command || "codex-acp",
			args: config.args ?? [],
		};
	}

	/** Check if codex-acp binary is available */
	static isAvailable(): boolean {
		try {
			execSync("which codex-acp", { stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	}

	/** Get codex-acp version */
	static getVersion(): string | null {
		try {
			const output = execSync("codex-acp --version", {
				encoding: "utf-8",
				stdio: "pipe",
			});
			return output.trim();
		} catch {
			return null;
		}
	}
}

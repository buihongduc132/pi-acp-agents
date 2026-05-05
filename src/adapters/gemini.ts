/**
 * pi-acp-agents — Gemini-specific ACP adapter
 */
import { AcpAgentAdapter } from "./base.js";
import type { AcpAgentConfig } from "../config/types.js";
import type { Logger } from "../logger.js";
import { execSync } from "node:child_process";

export interface GeminiAdapterOptions {
  config?: Partial<AcpAgentConfig>;
  clientInfo?: { name: string; version: string };
  logger?: Logger;
}

export class GeminiAcpAdapter extends AcpAgentAdapter {
  constructor(opts: Partial<GeminiAdapterOptions> = {}) {
    super({
      config: {
        command: "gemini",
        args: ["--acp"],
        ...opts.config,
      } as AcpAgentConfig,
      clientInfo: opts.clientInfo,
      logger: opts.logger,
    });
  }

  get name(): string {
    return "gemini";
  }

  protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
    return {
      ...config,
      command: config.command || "gemini",
      args: config.args ?? ["--acp"],
    };
  }

  /** Check if gemini CLI is available */
  static isAvailable(): boolean {
    try {
      execSync("which gemini", { stdio: "pipe" });
      return true;
    } catch (err) {
      console.debug("gemini not available:", err);
      return false;
    }
  }

  /** Get gemini CLI version */
  static getVersion(): string | null {
    try {
      const output = execSync("gemini --version", { encoding: "utf-8", stdio: "pipe" });
      return output.trim();
    } catch (err) {
      console.debug("gemini version check failed:", err);
      return null;
    }
  }
}

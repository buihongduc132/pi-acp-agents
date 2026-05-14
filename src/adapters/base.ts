/**
 * Base ACP Agent Adapter — abstract class for all ACP agent adapters.
 *
 * Subclasses provide agent-specific defaults via applyDefaults() and get name().
 * The base class handles the ACP lifecycle via AcpClient.
 */
import { AcpClient, type AcpClientOptions } from "../core/client.js";
import type { AcpAgentConfig, AcpAdapterOptions, AcpPromptResult } from "../config/types.js";
import type { Logger } from "../logger.js";
import { createNoopLogger } from "../logger.js";

export type { AcpAdapterOptions };

export abstract class AcpAgentAdapter {
  protected config: AcpAgentConfig;
  protected clientInfo: { name: string; version: string };
  protected logger: Logger;
  protected cwd: string;
  protected client: AcpClient | null = null;
  protected onActivity?: (sessionId: string) => void;

  constructor(opts: AcpAdapterOptions) {
    this.config = this.applyDefaults(opts.config);
    this.clientInfo = opts.clientInfo ?? { name: "pi-acp-agents", version: "0.1.0" };
    this.logger = opts.logger ?? createNoopLogger();
    this.cwd = opts.cwd ?? process.cwd();
    this.onActivity = opts.onActivity;
  }

  /** Subclasses override to provide agent-specific default config values */
  protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
    return { ...config };
  }

  /** Adapter name (e.g., "gemini", "custom") */
  abstract get name(): string;

  /** Spawn the agent process and establish ACP connection */
  async spawn(): Promise<void> {
    const client = new AcpClient({
      agentName: this.name,
      config: this.config,
      cwd: this.cwd,
      clientInfo: this.clientInfo,
      onActivity: this.onActivity,
    });
    await client.connect();
    // Only assign after successful connect
    this.client = client;
  }

  /** ACP initialize handshake */
  async initialize(): Promise<void> {
    if (!this.client) throw new Error("Not spawned — call spawn() first");
    await this.client.initialize();
  }

  /** Create a new session, returns sessionId */
  async newSession(_cwd?: string): Promise<string> {
    if (!this.client) throw new Error("Not spawned");
    return this.client.newSession();
  }

  /** Send a prompt and get the result */
  async prompt(message: string): Promise<AcpPromptResult> {
    if (!this.client) throw new Error("Not spawned");
    return this.client.quickPrompt(message);
  }

  /** Cancel ongoing prompt */
  async cancel(): Promise<void> {
    await this.client?.cancel();
  }

  /** Load an existing session by ID */
  async loadSession(sessionId: string): Promise<string> {
    if (!this.client) throw new Error("Not spawned");
    return this.client.loadSession(sessionId);
  }

  /** Set the model for the current session */
  async setModel(modelId: string): Promise<void> {
    if (!this.client) throw new Error("Not spawned");
    await this.client.setModel(modelId);
  }

  /** Set the mode (thinking level) for the current session */
  async setMode(modeId: string): Promise<void> {
    if (!this.client) throw new Error("Not spawned");
    await this.client.setMode(modeId);
  }

  /** Get current session ID */
  getSessionId(): string | null {
    return this.client?.sessionId ?? null;
  }

  /** Check if connected */
  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** Clean up — kill process and release resources */
  dispose(): void {
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }
  }
}

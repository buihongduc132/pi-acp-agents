/**
 * ACP Client — wraps ClientSideConnection from @agentclientprotocol/sdk.
 *
 * Manages the lifecycle of a single ACP client connection to one agent subprocess.
 * Maintains one persistent connection; collects text per-prompt via an accumulator.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { killWithEscalation } from "./circuit-breaker.js";
import type { AcpAgentConfig, AcpPromptResult } from "../config/types.js";
import type { Logger } from "../logger.js";
import { createFileLogger } from "../logger.js";

export interface AcpClientOptions {
  agentName: string;
  config: AcpAgentConfig;
  cwd?: string;
  clientInfo?: { name: string; version: string };
  logger?: Logger;
  logsDir?: string;
}

/**
 * AcpClient — manages a single ACP connection to one agent process.
 *
 * Flow: spawn → connect (creates ClientSideConnection) → initialize → newSession → prompt*
 */
export class AcpClient {
  private proc: ChildProcess | null = null;
  private conn: ClientSideConnection | null = null;
  private _sessionId: string | null = null;
  private _agentInfo: InitializeResponse | null = null;
  private collectedText = "";
  private agentName: string;
  private config: AcpAgentConfig;
  private cwd: string;
  private clientInfo: { name: string; version: string };
  private logger?: Logger;
  private sessionLogger?: Logger;
  private logsDir?: string;

  constructor(opts: AcpClientOptions) {
    this.agentName = opts.agentName;
    this.config = opts.config;
    this.cwd = opts.cwd ?? process.cwd();
    this.clientInfo = opts.clientInfo ?? { name: "pi-acp-agents", version: "0.1.0" };
    this.logger = opts.logger;
    this.logsDir = opts.logsDir;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get agentInfo(): InitializeResponse | null {
    return this._agentInfo;
  }

  get connected(): boolean {
    return this.conn !== null && this.proc !== null && !this.proc.killed;
  }

  /** Spawn the agent process and establish ACP connection */
  async connect(): Promise<void> {
    const cmd = this.config.command;
    const args = this.config.args ?? [];

    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error(`Failed to create stdio pipes for "${cmd}"`);
    }

    // Prevent EPIPE crashes
    this.proc.stdin.on("error", (err) => { this.logger?.debug("stdin error", err); });
    this.proc.stdout.on("error", (err) => { this.logger?.debug("stdout error", err); });
    this.proc.stderr?.on("error", (err) => { this.logger?.debug("stderr error", err); });
    this.proc.stderr?.on("data", () => {}); // drain stderr

    const webStdout = Readable.toWeb(this.proc.stdout) as ReadableStream<Uint8Array>;
    const webStdin = Writable.toWeb(this.proc.stdin) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(webStdin, webStdout);

    this.conn = new ClientSideConnection(
      () => ({
        sessionUpdate: (params: SessionNotification) => this.handleSessionUpdate(params),
        requestPermission: () =>
          Promise.resolve({ outcome: "approved" } as unknown as RequestPermissionResponse),
      }),
      stream,
    );
  }

  /** ACP initialize + auto-authenticate */
  async initialize(): Promise<InitializeResponse> {
    if (!this.conn) throw new Error("Not connected");

    const resp = await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: this.clientInfo,
    });

    this._agentInfo = resp;

    // Auto-authenticate with first available method
    if (resp.authMethods && resp.authMethods.length > 0) {
      try {
        await this.conn.authenticate({ methodId: resp.authMethods[0]!.id });
      } catch (err) {
        this.logger?.debug("Auth skipped or failed", err);
      }
    }

    return resp;
  }

  /** Create a new session */
  async newSession(): Promise<string> {
    if (!this.conn) throw new Error("Not connected");

    // Build mcpServers from config
    const mcpServers = (this.config.mcpServers ?? []).map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
    }));

    const resp: NewSessionResponse = await this.conn.newSession({
      cwd: this.cwd,
      mcpServers: mcpServers as any,
    });

    this._sessionId = resp.sessionId;

    // PH-15: Ensure session-specific log file exists for JSON-RPC traces
    this.ensureSessionLog(resp.sessionId);

    // Set model if configured (best-effort)
    if (this.config.defaultModel) {
      try {
        await this.conn.unstable_setSessionModel({
          sessionId: resp.sessionId,
          modelId: this.config.defaultModel,
        });
      } catch (err) {
        this.logger?.debug("Set model failed (best-effort)", err);
      }
    }

    // Set thinking level if configured (best-effort)
    if (this.config.thinkingLevel) {
      try {
        await this.conn.setSessionMode({
          sessionId: resp.sessionId,
          modeId: this.config.thinkingLevel,
        });
      } catch (err) {
        this.logger?.debug("Set mode failed (best-effort)", err);
      }
    }

    return resp.sessionId;
  }

  /** Send a prompt and collect the full response */
  async prompt(message: string): Promise<{ text: string; stopReason: string }> {
    if (!this.conn || !this._sessionId) {
      throw new Error("No active session");
    }

    this.collectedText = "";

    const resp: PromptResponse = await this.conn.prompt({
      sessionId: this._sessionId,
      prompt: [{ type: "text", text: message }],
    });

    return { text: this.collectedText, stopReason: resp.stopReason };
  }

  /** Full lifecycle: connect → initialize → newSession → prompt */
  async quickPrompt(message: string): Promise<AcpPromptResult> {
    if (!this.connected) {
      await this.connect();
      await this.initialize();
    }
    if (!this._sessionId) {
      await this.newSession();
    }
    const result = await this.prompt(message);
    return {
      text: result.text,
      stopReason: result.stopReason === "cancelled" ? "cancelled" : "end_turn",
      sessionId: this._sessionId!,
    };
  }

  /** Cancel an ongoing prompt */
  async cancel(): Promise<void> {
    if (this.conn && this._sessionId) {
      await this.conn.cancel({ sessionId: this._sessionId });
    }
  }

  /** Load an existing session by ID. Returns the sessionId. */
  async loadSession(sessionId: string): Promise<string> {
    if (!this.conn) throw new Error("Not connected");

    const resp = await this.conn.loadSession({
      sessionId,
      cwd: this.cwd,
      mcpServers: [],
    });

    // Use the loaded session as current
    this._sessionId = sessionId;
    return sessionId;
  }

  /** Set the model for the current session */
  async setModel(modelId: string): Promise<void> {
    if (!this.conn || !this._sessionId) throw new Error("No active session");
    await this.conn.unstable_setSessionModel({
      sessionId: this._sessionId,
      modelId,
    });
  }

  /** Set the mode (thinking level) for the current session */
  async setMode(modeId: string): Promise<void> {
    if (!this.conn || !this._sessionId) throw new Error("No active session");
    await this.conn.setSessionMode({
      sessionId: this._sessionId,
      modeId,
    });
  }

  /** PH-15: Ensure session-specific log file exists for JSON-RPC traces */
  private ensureSessionLog(sessionId: string): void {
    if (!this.logsDir) return;
    // Create session-specific logger that writes to logsDir/sessions/{sessionId}.jsonl
    this.sessionLogger = createFileLogger(this.logsDir, sessionId);
    this.sessionLogger.info("session created", { sessionId, agentName: this.agentName });
  }

  /** Kill the agent process and clean up */
  async dispose(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      killWithEscalation(this.proc);
    }
    this.conn = null;
    this.proc = null;
    this._sessionId = null;
  }

  /** Handle session/update notifications — accumulate text chunks */
  private async handleSessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update as Record<string, unknown>;
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) {
        this.collectedText += content.text;
      }
    }
  }
}

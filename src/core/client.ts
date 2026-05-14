/**
 * ACP Client — wraps ClientSideConnection from @agentclientprotocol/sdk.
 *
 * Manages the lifecycle of a single ACP client connection to one agent subprocess.
 * Maintains one persistent connection; collects text per-prompt via an accumulator.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

/**
 * Creates a filtered ReadableStream that strips non-JSON lines from agent stdout.
 *
 * Gemini CLI (and other ACP agents) may write stack traces, MCP error messages,
 * or other diagnostics to stdout. The ACP SDK's ndJsonStream tries JSON.parse on
 * every line, producing noisy "Failed to parse JSON message" console.errors.
 *
 * This filter intercepts stdout before ndJsonStream sees it, dropping lines that
 * don't start with '{' or '[' (valid JSON object/array starts).
 */
function createFilteredStdoutStream(rawStdout: ReadableStream<Uint8Array>, logger?: Logger): ReadableStream<Uint8Array> {
	const textDecoder = new TextDecoder();
	const textEncoder = new TextEncoder();
	let buffer = "";

	function isJsonLine(line: string): boolean {
		const trimmed = line.trim();
		if (!trimmed) return false;
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
		try {
			JSON.parse(trimmed);
			return true;
		} catch {
			return false;
		}
	}

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = rawStdout.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) {
						// flush remaining
						if (buffer.trim()) {
							const line = buffer.trim();
							if (isJsonLine(line)) {
								controller.enqueue(textEncoder.encode(line + "\n"));
							} else {
								logger?.debug("filtered non-JSON stdout (flush)", line.slice(0, 200));
							}
						}
						break;
					}
					if (!value) continue;
					buffer += textDecoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						if (isJsonLine(trimmed)) {
							controller.enqueue(textEncoder.encode(line + "\n"));
						} else {
							logger?.debug("filtered non-JSON stdout", trimmed.slice(0, 200));
						}
					}
				}
			} catch (err) {
				controller.error(err);
				return;
			} finally {
				reader.releaseLock();
			}
			controller.close();
		},
	});
}
import type {
	InitializeResponse,
	NewSessionResponse,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	ClientSideConnection,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { AcpAgentConfig, AcpPromptResult } from "../config/types.js";
import type { Logger } from "../logger.js";
import { createFileLogger } from "../logger.js";
import { killWithEscalation } from "./circuit-breaker.js";
import {
	AcpProtocolError,
	classifyConnectionError,
	validateInitializeResponse,
	validateNewSessionResponse,
	validatePromptResponse,
} from "./protocol-validator.js";

export interface AcpClientOptions {
	agentName: string;
	config: AcpAgentConfig;
	cwd?: string;
	clientInfo?: { name: string; version: string };
	logger?: Logger;
	logsDir?: string;
	onActivity?: (sessionId: string) => void;
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
	private lastStderr = "";
	private onActivity?: (sessionId: string) => void;

	constructor(opts: AcpClientOptions) {
		this.agentName = opts.agentName;
		this.config = opts.config;
		this.cwd = opts.cwd ?? process.cwd();
		this.clientInfo = opts.clientInfo ?? {
			name: "pi-acp-agents",
			version: "0.1.0",
		};
		this.logger = opts.logger;
		this.logsDir = opts.logsDir;
		this.onActivity = opts.onActivity;
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

		try {
			this.proc = spawn(cmd, args, {
				cwd: this.cwd,
				env: { ...process.env, ...this.config.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err: unknown) {
			throw classifyConnectionError(err, this.agentName, cmd);
		}

		if (!this.proc.stdin || !this.proc.stdout) {
			throw new AcpProtocolError({
				agentName: this.agentName,
				command: cmd,
				phase: "spawn",
				message: "Failed to create stdio pipes.",
				cause: `The process was created but stdin/stdout are not available. ` +
					`This can happen if the command is not a real process or doesn't support piped I/O.`,
			});
		}

		// Prevent EPIPE crashes
		this.proc.stdin.on("error", (err) => {
			this.logger?.debug("stdin error", err);
		});
		this.proc.stdout.on("error", (err) => {
			this.logger?.debug("stdout error", err);
		});
		this.proc.stderr?.on("error", (err) => {
			this.logger?.debug("stderr error", err);
		});
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			this.lastStderr += text;
			if (this.lastStderr.length > 2048)
				this.lastStderr = this.lastStderr.slice(-2048);
			this.logger?.debug("stderr", text);
		});

		const rawStdout = Readable.toWeb(
			this.proc.stdout,
		) as ReadableStream<Uint8Array>;
		const webStdin = Writable.toWeb(
			this.proc.stdin,
		) as WritableStream<Uint8Array>;

		// Filter non-JSON lines before passing to ndJsonStream to avoid
		// "Failed to parse JSON message" noise from stack traces / MCP errors
		const filteredStdout = createFilteredStdoutStream(rawStdout, this.logger);
		const stream = ndJsonStream(webStdin, filteredStdout);

		this.conn = new ClientSideConnection(
			() => ({
				sessionUpdate: (params: SessionNotification) =>
					this.handleSessionUpdate(params),
				requestPermission: () =>
					Promise.resolve({
						outcome: "approved",
					} as unknown as RequestPermissionResponse),
			}),
			stream,
		);
	}

	/** ACP initialize + auto-authenticate + protocol validation */
	async initialize(): Promise<InitializeResponse> {
		if (!this.conn) throw new Error("Not connected");

		let resp: InitializeResponse;
		try {
			resp = await this.conn.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
				clientInfo: this.clientInfo,
			});
		} catch (err: unknown) {
			throw classifyConnectionError(err, this.agentName, this.config.command, this.lastStderr);
		}

		// Behavior-based validation: does the response look like ACP?
		validateInitializeResponse(resp, this.agentName, this.config.command);

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

		let resp: NewSessionResponse;
		try {
			resp = await this.conn.newSession({
				cwd: this.cwd,
				mcpServers: [],
			});
		} catch (err: unknown) {
			throw classifyConnectionError(err, this.agentName, this.config.command, this.lastStderr);
		}

		// Behavior-based validation
		validateNewSessionResponse(resp, this.agentName, this.config.command);

		this._sessionId = resp.sessionId;

		// PH-15: Ensure session-specific log file exists for JSON-RPC traces
		this.ensureSessionLog(resp.sessionId);

		// Set default model if configured (best-effort, Zed-style default_model)
		if (this.config.default_model) {
			try {
				await this.conn.unstable_setSessionModel({
					sessionId: resp.sessionId,
					modelId: this.config.default_model,
				});
			} catch (err) {
				this.logger?.debug("Set model failed (best-effort)", err);
			}
		}

		// Set default mode if configured (best-effort, Zed-style default_mode)
		if (this.config.default_mode) {
			try {
				await this.conn.setSessionMode({
					sessionId: resp.sessionId,
					modeId: this.config.default_mode,
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
		const stderrBefore = this.lastStderr;

		let resp: PromptResponse;
		try {
			resp = await this.conn.prompt({
				sessionId: this._sessionId,
				prompt: [{ type: "text", text: message }],
			});
		} catch (err: unknown) {
			const classified = classifyConnectionError(err, this.agentName, this.config.command, this.lastStderr);
			if (classified instanceof AcpProtocolError) throw classified;
			const msg = err instanceof Error ? err.message : String(err);
			const stderrDelta = this.lastStderr.slice(stderrBefore.length).trim();
			throw new Error(
				`Prompt RPC failed: ${msg}` +
					(stderrDelta ? `\nAgent stderr:\n${stderrDelta}` : ""),
			);
		}

		// Behavior-based validation
		validatePromptResponse(resp, this.agentName, this.config.command);

		// Surface stopReason=error with stderr context
		if ((resp.stopReason as string) === "error") {
			const stderrDelta = this.lastStderr.slice(stderrBefore.length).trim();
			throw new Error(
				`Agent returned stopReason=error.\n` +
					`Collected text: ${this.collectedText || "(none)"}\n` +
					(stderrDelta ? `Agent stderr:\n${stderrDelta}` : "(no stderr)"),
			);
		}

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
		this.sessionLogger.info("session created", {
			sessionId,
			agentName: this.agentName,
		});
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
	private async handleSessionUpdate(
		params: SessionNotification,
	): Promise<void> {
		const update = params.update as Record<string, unknown>;
		const updateType = update.sessionUpdate;

		// Log all updates for debugging
		this.logger?.debug("session update", { updateType: String(updateType), keys: Object.keys(update) });

		// Fire activity callback for ALL update types (stall detection)
		if (this._sessionId) this.onActivity?.(this._sessionId);

		if (updateType === "agent_message_chunk" || updateType === "agent_thought_chunk") {
			const content = update.content as
				| { type?: string; text?: string }
				| undefined;
			if (content?.type === "text" && content.text) {
				this.collectedText += content.text;
			}
		}
	}
}

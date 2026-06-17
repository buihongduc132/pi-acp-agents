/**
 * ACP Client — wraps ClientSideConnection from @agentclientprotocol/sdk.
 *
 * Manages the lifecycle of a single ACP client connection to one agent subprocess.
 * Maintains one persistent connection; collects text per-prompt via an accumulator.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { platform } from "node:os";
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
			// Not valid JSON — expected for non-JSON stdout lines
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
	/**
	 * Deferred spawn error. Node's child_process.spawn() does NOT throw
	 * synchronously when the binary is missing (ENOENT) — it emits the error
	 * asynchronously via the process 'error' event. We capture it here so
	 * connect() (and every subsequent RPC) can reject cleanly instead of
	 * crashing the host with an unhandled 'error' event -> uncaughtException.
	 */
	private spawnError: Error | null = null;
	/**
	 * Process-exit-before-handshake error. A binary that EXISTS but exits
	 * (any code) before the ACP initialize handshake completes is broken; we
	 * capture it here so initialize()/newSession() reject fast instead of
	 * hanging to a RPC timeout. (Does NOT fire proc 'error' — only 'exit'.)
	 */
	private processExitError: Error | null = null;
	private spawnErrorListeners: Array<(err: Error) => void> = [];
	/**
	 * GAP-4: when true, the persistent proc.on('error')/on('exit') callbacks
	 * become no-ops so a late event from a killed process cannot mutate state
	 * of an already-disposed client. Reset to false at the top of connect().
	 */
	private disposed = false;

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

	/**
	 * Spawn the agent process and establish ACP connection.
	 *
	 * IMPORTANT: Node's child_process.spawn() does NOT throw synchronously
	 * when the binary is missing (ENOENT). It returns a ChildProcess and emits
	 * the error asynchronously via the 'error' event on the next tick. If no
	 * 'error' listener is attached, Node throws on that tick ->
	 * uncaughtException -> host (pi) crashes. Likewise, a binary that exists
	 * but exits before the handshake only fires 'exit' (not 'error').
	 *
	 * We therefore:
	 *   1. Attach proc.on('error') + proc.on('exit') IMMEDIATELY after spawn
	 *      returns (before any await), so the error/exit is captured, never
	 *      leaked. Both callbacks are inert once `disposed` is true (GAP-4).
	 *   2. Race the rest of connect() against a spawn-error promise, so an
	 *      ENOENT or early-exit surfaces as a clean rejection.
	 */
	async connect(): Promise<void> {
		// Reset lifecycle state so a fresh connect() after dispose() does not
		// resurrect stale spawn/exit errors from a previous process (GAP-4).
		this.disposed = false;
		this.spawnError = null;
		this.processExitError = null;
		this.spawnErrorListeners = [];

		const cmd = this.config.command;
		if (!cmd) throw new Error(`Agent "${this.agentName}" has no command configured for direct mode`);
		const args = this.config.args ?? [];

		try {
			this.proc = spawn(cmd, args, {
				cwd: this.cwd,
				env: { ...process.env, ...this.config.env },
				stdio: ["pipe", "pipe", "pipe"],
				shell: platform() === "win32",
			});
		} catch (err: unknown) {
			throw classifyConnectionError(err, this.agentName, cmd);
		}

		// Attach process-level listeners IMMEDIATELY — before any await and
		// before the stdin/stdout null check. This is the safety net for async
		// spawn errors (ENOENT, EACCES, EAGAIN) delivered on the next tick, and
		// for early process exit (binary exists but crashes / wrong args).
		// Without proc.on('error'), an unhandled 'error' event on a
		// ChildProcess throws synchronously -> uncaughtException -> pi dies.
		this.proc!.on("error", (err: NodeJS.ErrnoException) => {
			this.logger?.debug("process error event", err);
			this.captureFatalSpawnError("spawnError", err);
		});
		this.proc!.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			this.logger?.debug("process exit event", { code, signal });
			// Only fatal if the process died BEFORE the ACP initialize handshake
		// completed. Post-handshake exits are normal session termination.
			if (this._agentInfo !== null) return;
			const exitErr = new AcpProtocolError({
				agentName: this.agentName,
				command: cmd,
				phase: "spawn",
				message:
					`Command "${cmd}" exited immediately` +
					(code !== null ? ` with non-zero status ${code}` : "") +
					(signal ? ` (signal ${signal})` : "") + `.`,
				cause:
					"The process started but exited before completing the ACP " +
					"handshake. Check the command/args; the binary may be missing " +
					"the ACP flag (e.g. '--acp' or 'acp') or crashed on startup." +
					(this.lastStderr ? `\nStderr: ${this.lastStderr.slice(0, 500)}` : ""),
			});
			this.captureFatalSpawnError("processExitError", exitErr);
		});

		// If the spawn already failed async (race window), reject now.
		if (this.spawnError || this.processExitError) {
			throw classifyConnectionError(
				(this.spawnError ?? this.processExitError)!,
				this.agentName,
				cmd,
				this.lastStderr,
			);
		}

		if (!this.proc!.stdin || !this.proc!.stdout) {
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
		this.proc!.stdin.on("error", (err) => {
			this.logger?.debug("stdin error", err);
		});
		this.proc!.stdout.on("error", (err) => {
			this.logger?.debug("stdout error", err);
		});
		this.proc!.stderr?.on("error", (err) => {
			this.logger?.debug("stderr error", err);
		});
		this.proc!.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			this.lastStderr += text;
			if (this.lastStderr.length > 2048)
				this.lastStderr = this.lastStderr.slice(-2048);
			this.logger?.debug("stderr", text);
		});

		const rawStdout = Readable.toWeb(
			this.proc!.stdout,
		) as ReadableStream<Uint8Array>;
		const webStdin = Writable.toWeb(
			this.proc!.stdin,
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

		// Final guard: race any deferred spawn error / early exit (ENOENT and
		// process-exit both fire on later ticks) against successful return.
		await this.guardAgainstSpawnError(cmd);
	}

	/**
	 * Capture a fatal pre-handshake error (async spawn 'error' or early
	 * 'exit') into the appropriate field and notify any in-flight
	 * connect()/initialize()/newSession()/prompt() caller. Inert once the
	 * client is disposed (GAP-4).
		 */
	private captureFatalSpawnError(
		kind: "spawnError" | "processExitError",
		err: Error,
	): void {
		if (this.disposed) return; // GAP-4: late events on a killed proc are ignored
		if (kind === "spawnError") {
			if (!this.spawnError) this.spawnError = err;
		} else {
			if (!this.processExitError) this.processExitError = err;
		}
		const listeners = this.spawnErrorListeners.splice(0);
		for (const fn of listeners) {
			try { fn(err); } catch { /* listener errors must not propagate */ }
		}
	}

	/**
	 * The current fatal pre-handshake error, if any (spawn 'error' takes
	 * precedence over early 'exit').
		 */
	private get fatalSpawnError(): Error | null {
		return this.spawnError ?? this.processExitError;
	}

	/**
	 * If a spawn error / early exit has fired (or fires within one event-loop
	 * turn), reject with a classified, stderr-enriched error. Otherwise resolve.
	 *
	 * Note on timing: yielding one setImmediate turn is empirically sufficient
	 * for libuv to deliver a pending ENOENT on POSIX. It is NOT a hard
	 * contract (Windows libuv timing is less deterministic; under heavy
	 * event-loop load delivery can slip). The persistent proc.on('error') /
	 * on('exit') listeners are the real safety net — they reject this promise
	 * synchronously when the event arrives. We additionally RE-READ
	 * this.fatalSpawnError after the await so a slowly-delivered error that
	 * set the field without yet draining listeners still surfaces here.
		 */
	private guardAgainstSpawnError(cmd: string): Promise<void> {
		const immediate = this.fatalSpawnError;
		if (immediate) {
			return Promise.reject(
				classifyConnectionError(immediate, this.agentName, cmd, this.lastStderr),
			);
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onErr = (err: Error) => {
				if (settled) return;
				settled = true;
				reject(classifyConnectionError(err, this.agentName, cmd, this.lastStderr));
			};
			this.spawnErrorListeners.push(onErr);
			setImmediate(() => {
				if (settled) return; // error/exit already rejected via listener
				settled = true;
				const idx = this.spawnErrorListeners.indexOf(onErr);
				if (idx >= 0) this.spawnErrorListeners.splice(idx, 1);
				// Defensive re-check: a slow-delivered event may have set the field
				// without the listener draining yet.
				const late = this.fatalSpawnError;
				if (late) {
					reject(classifyConnectionError(late, this.agentName, cmd, this.lastStderr));
					return;
				}
				resolve();
			});
		});
	}

	/** ACP initialize + auto-authenticate + protocol validation */
	async initialize(): Promise<InitializeResponse> {
		// GAP-1: surface a deferred spawn error / early exit as a classified
		// rejection instead of awaiting this.conn.*() against a dead process.
		if (this.fatalSpawnError) {
			throw classifyConnectionError(
				this.fatalSpawnError, this.agentName, this.config.command!, this.lastStderr,
			);
		}
		if (!this.conn) throw new Error("Not connected");

		let resp: InitializeResponse;
		try {
			resp = await this.conn.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
				clientInfo: this.clientInfo,
			});
		} catch (err: unknown) {
			throw classifyConnectionError(err, this.agentName, this.config.command!, this.lastStderr);
		}

		// Behavior-based validation: does the response look like ACP?
		validateInitializeResponse(resp, this.agentName, this.config.command!);

		this._agentInfo = resp;

		// Auto-authenticate with first available method
		if (resp.authMethods && resp.authMethods.length > 0) {
			try {
				await this.conn.authenticate({ methodId: resp.authMethods[0]!.id });
			} catch (err) {
								// Auth is best-effort — may fail if no auth needed
				this.logger?.debug("Auth skipped or failed", err);
			}
		}

		return resp;
	}

	/** Create a new session */
	async newSession(): Promise<string> {
		// GAP-1: surface deferred spawn error / early exit fast.
		if (this.fatalSpawnError) {
			throw classifyConnectionError(
				this.fatalSpawnError, this.agentName, this.config.command!, this.lastStderr,
			);
		}
		if (!this.conn) throw new Error("Not connected");

		let resp: NewSessionResponse;
		try {
			resp = await this.conn.newSession({
				cwd: this.cwd,
				mcpServers: [],
			});
		} catch (err: unknown) {
			throw classifyConnectionError(err, this.agentName, this.config.command!, this.lastStderr);
		}

		// Behavior-based validation
		validateNewSessionResponse(resp, this.agentName, this.config.command!);

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
								// Setting model is best-effort
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
								// Setting mode is best-effort
				this.logger?.debug("Set mode failed (best-effort)", err);
			}
		}

		return resp.sessionId;
	}

	/** Send a prompt and collect the full response */
	async prompt(message: string): Promise<{ text: string; stopReason: string }> {
		// GAP-1: surface deferred spawn error / early exit fast.
		if (this.fatalSpawnError) {
			throw classifyConnectionError(
				this.fatalSpawnError, this.agentName, this.config.command!, this.lastStderr,
			);
		}
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
			const classified = classifyConnectionError(err, this.agentName, this.config.command!, this.lastStderr);
			if (classified instanceof AcpProtocolError) throw classified;
			const msg = err instanceof Error ? err.message : String(err);
			const stderrDelta = this.lastStderr.slice(stderrBefore.length).trim();
			throw new Error(
				`Prompt RPC failed: ${msg}` +
					(stderrDelta ? `\nAgent stderr:\n${stderrDelta}` : ""),
			);
		}

		// Behavior-based validation
		validatePromptResponse(resp, this.agentName, this.config.command!);

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
		// GAP-4: mark disposed FIRST so any late 'error'/'exit' event emitted
		// by killWithEscalation / OS cleanup becomes inert (captureFatalSpawnError
		// returns immediately) and cannot mutate state of this dead client.
		this.disposed = true;
		// Drop pending listeners so a late event doesn't reject a promise nobody awaits.
		this.spawnErrorListeners = [];
		this.spawnError = null;
		this.processExitError = null;
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

/**
 * pi-acp-agents — ACPX CLI adapter.
 *
 * Delegates ACP agent interaction to the `acpx` CLI instead of managing
 * a subprocess directly. Session lifecycle is handled via CLI commands:
 *   - spawn  → acpx sessions create
 *   - prompt → acpx sessions prompt
 *   - cancel → acpx sessions cancel
 *   - dispose → acpx sessions close
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import type { AcpAdapterOptions, AcpPromptResult } from "../config/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 3600; // 1 hour
const ACX_BINARY = "acpx";

/**
 * Escape a string for safe use as a cmd.exe argument on Windows.
 * When shell:true is used, cmd.exe interprets metacharacters like & | < > ^ %.
 * This wraps the arg in double quotes and escapes internal quotes and carets.
 */
function escapeWindowsArg(arg: string): string {
	// cmd.exe metacharacters: & | < > ^ % ( ) "
	// Wrap in quotes and escape internal quotes with ^"
	const escaped = arg.replace(/"/g, '""');
	return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface AcpxSessionState {
	sessionId: string | null;
	connected: boolean;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AcpxAdapter {
	public readonly name = "acpx";
	private state: AcpxSessionState = { sessionId: null, connected: false };
	private cwd: string;
	private agentName: string;

	constructor(opts: AcpAdapterOptions) {
		this.cwd = opts.cwd ?? process.cwd();
		this.agentName = opts.agentName ?? (opts.config.command
			? opts.config.command.split("/").pop() ?? "acpx"
			: "acpx");
	}

	// -----------------------------------------------------------------------
	// Public API — matches AcpAgentAdapter surface
	// -----------------------------------------------------------------------

	async spawn(): Promise<void> {
		let result: ReturnType<typeof spawnSync>;
		try {
			result = this._runAcpx(["sessions", "create", this.agentName, "--format", "json"]);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`AcpxAdapter spawn failed: ${msg}`);
		}
		if (result.error) {
			throw new Error(`AcpxAdapter spawn failed: ${result.error.message}`);
		}
		if (result.status !== 0) {
			const err = String(result.stderr ?? "").trim() || "acpx sessions create failed";
			throw new Error(`AcpxAdapter spawn failed: ${err}`);
		}
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(String(result.stdout));
		} catch {
			throw new Error(`AcpxAdapter spawn failed: invalid JSON response`);
		}
		const sessionId = parsed["sessionId"];
		this.state.sessionId = typeof sessionId === "string" ? sessionId : null;
		this.state.connected = true;
	}

	async initialize(): Promise<void> {
		// acpx manages its own init; no separate handshake needed
		if (!this.state.connected) {
			throw new Error("Not spawned — call spawn() first");
		}
	}

	async newSession(_cwd?: string): Promise<string> {
		if (!this.state.connected) throw new Error("Not spawned");
		// acpx creates a new session per spawn; return current ID
		if (!this.state.sessionId) {
			throw new Error("No session ID after spawn");
		}
		return this.state.sessionId;
	}

	async prompt(message: string): Promise<AcpPromptResult> {
		if (!this.state.connected) throw new Error("Not spawned — call spawn() first");
		if (!this.state.sessionId) throw new Error("No session ID");

		const timeout = DEFAULT_TIMEOUT_SEC;
		const args = [
			"sessions", "prompt",
			"--session", this.state.sessionId,
			"--format", "json",
			"--approve-all",
			"--timeout", String(timeout),
			"--",
			message,
		];
		let result: ReturnType<typeof spawnSync>;
		try {
			result = this._runAcpx(args);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`AcpxAdapter prompt failed: ${msg}`);
		}
		if (result.error) {
			throw new Error(`AcpxAdapter prompt failed: ${result.error.message}`);
		}
		if (result.status !== 0) {
			const err = String(result.stderr ?? "").trim() || "acpx prompt failed";
			throw new Error(`AcpxAdapter prompt failed: ${err}`);
		}
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(String(result.stdout));
		} catch {
			throw new Error(`AcpxAdapter prompt failed: invalid JSON response`);
		}
		const text = typeof parsed["text"] === "string" ? parsed["text"] : "";
		const stopReason = typeof parsed["stopReason"] === "string"
			? parsed["stopReason"]
			: typeof parsed["stop_reason"] === "string" ? parsed["stop_reason"] : "end_turn";
		const sessionId = typeof parsed["sessionId"] === "string"
			? parsed["sessionId"]
			: typeof parsed["session_id"] === "string" ? parsed["session_id"] : this.state.sessionId!;
		return {
			text,
			stopReason,
			sessionId,
		};
	}

	async cancel(): Promise<void> {
		if (!this.state.sessionId) return;
		try {
			this._runAcpx(["sessions", "cancel", "--session", this.state.sessionId]);
		} catch {
			// best-effort — cancel must not throw
		}
	}

	async loadSession(sessionId: string): Promise<string> {
		this.state.sessionId = sessionId;
		this.state.connected = true;
		return sessionId;
	}

	async setModel(_modelId: string): Promise<void> {
		// acpx doesn't support per-session model switching via CLI
		// Model is configured at the acpx profile level
	}

	async setMode(_modeId: string): Promise<void> {
		// acpx doesn't support per-session mode switching via CLI
	}

	getSessionId(): string | null {
		return this.state.sessionId;
	}

	get connected(): boolean {
		return this.state.connected;
	}

	dispose(): void {
		if (this.state.sessionId) {
			try {
				this._runAcpx(["sessions", "close", this.state.sessionId]);
			} catch {
				// best-effort — dispose must not throw
			}
		}
		this.state.sessionId = null;
		this.state.connected = false;
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private _runAcpx(args: string[]) {
		const isWindows = platform() === "win32";
		// When shell:true on Windows, cmd.exe interprets metacharacters (&, |, <, >, ^, %).
		// Escape args that may contain user-controlled content (e.g. prompt messages).
		const safeArgs = isWindows ? args.map(escapeWindowsArg) : args;
		return spawnSync(ACX_BINARY, safeArgs, {
			cwd: this.cwd,
			encoding: "utf-8",
			timeout: 120_000, // 2 min for CLI itself; prompt timeout is passed to acpx
			maxBuffer: 10 * 1024 * 1024, // 10 MB
			shell: isWindows,
		});
	}
}

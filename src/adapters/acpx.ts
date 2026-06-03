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
import type { AcpAdapterOptions, AcpPromptResult } from "../config/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 3600; // 1 hour
const ACX_BINARY = "acpx";

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
		const result = this._runAcpx(["sessions", "create", this.agentName, "--format", "json"]);
		if (result.status !== 0) {
			const err = result.stderr?.trim() || "acpx sessions create failed";
			throw new Error(`AcpxAdapter spawn failed: ${err}`);
		}
		const parsed = JSON.parse(result.stdout);
		this.state.sessionId = parsed.sessionId ?? null;
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
		const result = this._runAcpx(args);
		if (result.status !== 0) {
			const err = result.stderr?.trim() || "acpx prompt failed";
			throw new Error(`AcpxAdapter prompt failed: ${err}`);
		}
		const parsed = JSON.parse(result.stdout);
		return {
			text: parsed.text ?? "",
			stopReason: parsed.stopReason ?? parsed.stop_reason ?? "end_turn",
			sessionId: parsed.sessionId ?? parsed.session_id ?? this.state.sessionId!,
		};
	}

	async cancel(): Promise<void> {
		if (!this.state.sessionId) return;
		this._runAcpx(["sessions", "cancel", "--session", this.state.sessionId]);
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
			this._runAcpx(["sessions", "close", this.state.sessionId]);
		}
		this.state.sessionId = null;
		this.state.connected = false;
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private _runAcpx(args: string[]) {
		return spawnSync(ACX_BINARY, args, {
			cwd: this.cwd,
			encoding: "utf-8",
			timeout: 120_000, // 2 min for CLI itself; prompt timeout is passed to acpx
			maxBuffer: 10 * 1024 * 1024, // 10 MB
		});
	}
}

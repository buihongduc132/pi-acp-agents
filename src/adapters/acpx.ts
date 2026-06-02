/**
 * pi-acp-agents — ACPX CLI adapter
 *
 * Runs agent sessions via the `acpx` CLI tool instead of direct subprocess
 * management. Supports initialize, prompt, cancel, and dispose via CLI calls.
 */
import { execFile } from "node:child_process";
import { AcpAgentAdapter, type AcpAdapterOptions } from "./base.js";
import type { AcpPromptResult } from "../config/types.js";

export class AcpxAdapter extends AcpAgentAdapter {
	private acpxSessionId: string | null = null;
	private acpxAgentName: string;

	get name(): string {
		return "acpx";
	}

	constructor(opts: AcpAdapterOptions) {
		super(opts);
		// Store the agent name for acpx session creation.
		// Can come from opts.agentName (adapter-level) or opts.config.agentName (config-level).
		this.acpxAgentName = opts.agentName ?? (opts.config as Record<string, unknown>).agentName as string | undefined ?? this.name;
	}

	/** Spawn: create an acpx session and capture its ID */
	override async spawn(): Promise<void> {
		const args = ["sessions", "create", this.acpxAgentName, "--format", "json"];

		const stdout = await this.execAcpx(args);
		const parsed = JSON.parse(stdout) as Record<string, unknown>;

		const sessionId = parsed.sessionId as string | undefined;
		if (!sessionId) {
			throw new Error(`acpx sessions create returned no sessionId: ${stdout}`);
		}
		this.acpxSessionId = sessionId;
	}

	/** Send a prompt via acpx CLI and parse the response */
	override async prompt(message: string): Promise<AcpPromptResult> {
		if (!this.acpxSessionId) {
			throw new Error("Not spawned — call spawn() first");
		}

		const timeoutSec = this.config.stallTimeoutMs
			? Math.ceil(this.config.stallTimeoutMs / 1000)
			: undefined;

		const args: string[] = [
			"prompt",
			"--session",
			this.acpxSessionId,
			"--format",
			"json",
			"--approve-all",
		];

		if (timeoutSec) {
			args.push("--timeout", String(timeoutSec));
		}

		if (this.cwd) {
			args.push("--cwd", this.cwd);
		}

		// Append the prompt message as the last argument
		args.push("--", message);

		const stdout = await this.execAcpx(args);
		const parsed = JSON.parse(stdout) as Record<string, unknown>;

		if (parsed.error) {
			throw new Error(String(parsed.error));
		}

		return {
			text: String(parsed.text ?? ""),
			stopReason: String(parsed.stopReason ?? "unknown"),
			sessionId: String(parsed.sessionId ?? this.acpxSessionId),
		};
	}

	/** Cancel the in-flight prompt for the current acpx session */
	override async cancel(): Promise<void> {
		if (!this.acpxSessionId) return;

		try {
			await this.execAcpx(["sessions", "cancel", this.acpxSessionId]);
		} catch {
			// Best-effort: cancel is not critical
		}
	}

	/** Close the acpx session and clean up */
	override dispose(): void {
		if (this.acpxSessionId) {
			const sid = this.acpxSessionId;
			this.acpxSessionId = null;
			// Fire-and-forget via execFile (avoids execFileSync which is harder to mock in tests)
			execFile(
				"acpx",
				["sessions", "close", sid],
				{ timeout: 10_000, cwd: this.cwd },
				() => { /* best-effort: errors are silently ignored */ },
			);
		}
		// Also call base dispose for any client cleanup
		super.dispose();
	}

	/** Override connected to reflect acpx session state */
	override get connected(): boolean {
		return this.acpxSessionId !== null;
	}

	/** Override getSessionId to return acpx session id */
	override getSessionId(): string | null {
		return this.acpxSessionId;
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	private execAcpx(args: string[]): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			execFile(
				"acpx",
				args,
				{ timeout: this.config.stallTimeoutMs ?? 3_600_000, cwd: this.cwd },
				(err, stdout, _stderr) => {
					if (err) {
						reject(err);
					} else {
						resolve(stdout.trim());
					}
				},
			);
		});
	}

	private execAcpxSync(args: string[]): string {
		// Use execFile wrapped in sync promise for testability (avoids execFileSync which is harder to mock)
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		try {
			return execFileSync("acpx", args, {
				timeout: 10_000,
				cwd: this.cwd,
				encoding: "utf-8",
			}).trim();
		} catch (err: unknown) {
			// Best-effort: dispose should not throw
			return "";
		}
	}
}

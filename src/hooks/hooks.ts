/**
 * resolveHookCommand + runAcpHook — cross-platform hook resolution and
 * execution with the teams-compat env-var superset (LD1).
 *
 * Follows the RED test contract:
 *   resolveHookCommand(scriptPath) → { command, args }
 *   runAcpHook(path | paths[], { event, context, timeoutMs })
 *     → HookRunResult | { results: HookRunResult[] }
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";

import type { HookContext, HookEventName } from "./types.js";

export interface ResolvedCommand {
	command: string;
	args: string[];
}

/**
 * Resolve a hook script path to an executable command.
 *
 * - `.sh`   → bash <path>
 * - `.ps1`  → pwsh <path>
 * - `.js`/`.mjs` → node <path>
 * - other + executable bit → run path directly
 */
export function resolveHookCommand(scriptPath: string): ResolvedCommand {
	const ext = extname(scriptPath).toLowerCase();
	switch (ext) {
		case ".sh":
			return { command: "bash", args: [scriptPath] };
		case ".ps1":
			return { command: "pwsh", args: [scriptPath] };
		case ".js":
		case ".mjs":
			return { command: "node", args: [scriptPath] };
		default: {
			// Executable binary: run directly (POSIX)
			try {
				const st = statSync(scriptPath);
				const isExec = (st.mode & 0o111) !== 0;
				if (isExec) {
					return { command: scriptPath, args: [] };
				}
			} catch {
				// fall through
			}
			// Non-executable unknown extension: try bash as a best effort
			return { command: "bash", args: [scriptPath] };
		}
	}
}

export interface HookRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	success: boolean;
	timedOut: boolean;
	skipped: boolean;
}

export interface RunAcpHookOptions {
	event: HookEventName;
	context: HookContext;
	timeoutMs: number;
}

/**
 * Build the teams-compat env-var superset (LD1) passed to hook processes.
 */
function buildHookEnv(context: HookContext): Record<string, string> {
	const ctxJson = JSON.stringify(context);
	return {
		ACP_HOOK_EVENT: context.event,
		ACP_HOOK_CONTEXT_VERSION: String(context.version),
		ACP_HOOK_CONTEXT_JSON: ctxJson,
		ACP_HOOK_CORRELATION_ID: context.correlationId,
		ACP_TASK_ID: context.task?.id ?? "",
		ACP_TASK_SUBJECT: context.task?.subject ?? "",
		ACP_TASK_OWNER: "",
		ACP_TASK_STATUS: context.task?.status ?? "",
		ACP_WORKER_NAME: context.agent?.name ?? "",
		ACP_AGENT_NAME: context.agent?.name ?? "",
		ACP_SESSION_ID: context.session?.id ?? "",
		ACP_TIMESTAMP: context.timestamp,
	};
}

/**
 * Run one or many hook scripts. Returns a single HookRunResult for a string
 * input, or `{ results: [...] }` for an array input.
 */
export function runAcpHook(
	target: string,
	opts: RunAcpHookOptions,
): Promise<HookRunResult>;
export function runAcpHook(
	target: string[],
	opts: RunAcpHookOptions,
): Promise<{ results: HookRunResult[] }>;
export async function runAcpHook(
	target: string | string[],
	opts: RunAcpHookOptions,
): Promise<HookRunResult | { results: HookRunResult[] }> {
	if (Array.isArray(target)) {
		const results = await Promise.all(
			target.map((p) => runOne(p, opts)),
		);
		return { results };
	}
	return runOne(target, opts);
}

function runOne(
	scriptPath: string,
	opts: RunAcpHookOptions,
): Promise<HookRunResult> {
	return new Promise((resolve) => {
		if (!existsSync(scriptPath)) {
			resolve({
				exitCode: 0,
				stdout: "",
				stderr: "",
				success: true,
				timedOut: false,
				skipped: true,
			});
			return;
		}

		const { command, args } = resolveHookCommand(scriptPath);
		const env = { ...process.env, ...buildHookEnv(opts.context) };

		const child = spawn(command, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: true,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			// Process group kill is Unix-only; on Windows fall back to direct kill
			let killed = false;
			if (process.platform !== "win32") {
				try { process.kill(-child.pid!, "SIGTERM"); killed = true; } catch { /* fallback below */ }
			}
			if (!killed) { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
			// Force kill if still alive shortly after
			setTimeout(() => {
				let forceKilled = false;
				if (process.platform !== "win32") {
					try { process.kill(-child.pid!, "SIGKILL"); forceKilled = true; } catch { /* fallback below */ }
				}
				if (!forceKilled) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
			}, 200);
		}, opts.timeoutMs);

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode,
				stdout,
				stderr,
				success: !timedOut && exitCode === 0,
				timedOut,
				skipped: false,
			});
		};

		child.on("error", () => {
			// Spawn failure (e.g. missing interpreter) → treat as failure
			finish(127);
		});
		child.on("close", (code) => {
			finish(code ?? 0);
		});
	});
}

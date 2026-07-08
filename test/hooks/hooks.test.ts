import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHookCommand, runAcpHook } from "../../src/hooks/hooks.js";

describe("resolveHookCommand — cross-platform resolution", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-hook-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves .sh scripts to bash", () => {
		const scriptPath = join(dir, "on-complete.sh");
		writeFileSync(scriptPath, "#!/usr/bin/env bash\necho hi\n");
		const resolved = resolveHookCommand(scriptPath);
		expect(resolved.command).toBe("bash");
		expect(resolved.args).toContain(scriptPath);
	});

	it("resolves .ps1 scripts to pwsh", () => {
		const scriptPath = join(dir, "on-complete.ps1");
		writeFileSync(scriptPath, "Write-Output 'hi'\n");
		const resolved = resolveHookCommand(scriptPath);
		expect(resolved.command).toBe("pwsh");
		expect(resolved.args).toContain(scriptPath);
	});

	it("resolves .js scripts to node", () => {
		const scriptPath = join(dir, "on-complete.js");
		writeFileSync(scriptPath, "console.log('hi')\n");
		const resolved = resolveHookCommand(scriptPath);
		expect(resolved.command).toBe("node");
		expect(resolved.args).toContain(scriptPath);
	});

	it("resolves .mjs scripts to node", () => {
		const scriptPath = join(dir, "on-complete.mjs");
		writeFileSync(scriptPath, "console.log('hi')\n");
		const resolved = resolveHookCommand(scriptPath);
		expect(resolved.command).toBe("node");
		expect(resolved.args).toContain(scriptPath);
	});

	it("uses executable binary directly when no known extension", () => {
		const scriptPath = join(dir, "on-complete");
		writeFileSync(scriptPath, "#!/usr/bin/env bash\necho hi\n");
		chmodSync(scriptPath, 0o755);
		const resolved = resolveHookCommand(scriptPath);
		// executable binary: command is the script itself
		expect(resolved.command).toBe(scriptPath);
		expect(Array.isArray(resolved.args)).toBe(true);
	});
});

describe("runAcpHook — teams-compat env vars", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-hook-env-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes all ACP_* env vars to the hook process", async () => {
		const scriptPath = join(dir, "dump-env.sh");
		writeFileSync(
			scriptPath,
			[
				"#!/usr/bin/env bash",
				'echo "ACP_HOOK_EVENT=$ACP_HOOK_EVENT"',
				'echo "ACP_HOOK_CONTEXT_JSON=$ACP_HOOK_CONTEXT_JSON"',
				'echo "ACP_HOOK_CONTEXT_VERSION=$ACP_HOOK_CONTEXT_VERSION"',
				'echo "ACP_HOOK_CORRELATION_ID=$ACP_HOOK_CORRELATION_ID"',
				'echo "ACP_TASK_ID=$ACP_TASK_ID"',
				'echo "ACP_TASK_SUBJECT=$ACP_TASK_SUBJECT"',
				'echo "ACP_TASK_OWNER=$ACP_TASK_OWNER"',
				'echo "ACP_TASK_STATUS=$ACP_TASK_STATUS"',
				'echo "ACP_WORKER_NAME=$ACP_WORKER_NAME"',
				'echo "ACP_AGENT_NAME=$ACP_AGENT_NAME"',
				'echo "ACP_SESSION_ID=$ACP_SESSION_ID"',
				'echo "ACP_TIMESTAMP=$ACP_TIMESTAMP"',
				"exit 0",
				"",
			].join("\n"),
		);
		chmodSync(scriptPath, 0o755);

		const context = {
			version: 1 as const,
			event: "task_completed" as const,
			source: "acp" as const,
			correlationId: "11111111-2222-3333-4444-555555555555",
			session: { id: "sess-1", agent: "pi", cwd: dir },
			agent: { name: "coder", type: "acp" },
			task: {
				id: "task-1",
				subject: "do thing",
				status: "completed",
			},
			timestamp: new Date("2026-07-09T00:00:00Z").toISOString(),
		};

		const result = await runAcpHook(scriptPath, {
			event: "task_completed",
			context,
			timeoutMs: 5000,
		});

		expect(result.exitCode).toBe(0);
		const stdout = result.stdout ?? "";
		expect(stdout).toContain("ACP_HOOK_EVENT=task_completed");
		expect(stdout).toContain("ACP_HOOK_CONTEXT_VERSION=1");
		expect(stdout).toContain("ACP_HOOK_CORRELATION_ID=11111111-2222-3333-4444-555555555555");
		expect(stdout).toContain("ACP_TASK_ID=task-1");
		expect(stdout).toContain("ACP_TASK_SUBJECT=do thing");
		expect(stdout).toContain("ACP_AGENT_NAME=coder");
		expect(stdout).toContain("ACP_SESSION_ID=sess-1");
		// ACP_HOOK_CONTEXT_JSON must contain the full serialized context
		expect(stdout).toContain('"correlationId":"11111111-2222-3333-4444-555555555555"');
	});

	it("respects timeoutMs from config", async () => {
		const scriptPath = join(dir, "slow.sh");
		writeFileSync(
			scriptPath,
			["#!/usr/bin/env bash", "sleep 5", "exit 0", ""].join("\n"),
		);
		chmodSync(scriptPath, 0o755);

		const context = {
			version: 1 as const,
			event: "session_started" as const,
			source: "acp" as const,
			correlationId: "22222222-3333-4444-5555-666666666666",
			session: { id: "sess-2", agent: "pi", cwd: dir },
			agent: { name: "general", type: "acp" },
			timestamp: new Date().toISOString(),
		};

		const start = Date.now();
		const result = await runAcpHook(scriptPath, {
			event: "session_started",
			context,
			timeoutMs: 300,
		});
		const elapsed = Date.now() - start;

		// must abort around timeoutMs, not wait for sleep 5
		expect(elapsed).toBeLessThan(3000);
		expect(result.timedOut).toBe(true);
	});

	it("captures non-zero exit code", async () => {
		const scriptPath = join(dir, "fail.sh");
		writeFileSync(
			scriptPath,
			["#!/usr/bin/env bash", "exit 42", ""].join("\n"),
		);
		chmodSync(scriptPath, 0o755);

		const context = {
			version: 1 as const,
			event: "task_failed" as const,
			source: "acp" as const,
			correlationId: "33333333-4444-5555-6666-777777777777",
			session: { id: "sess-3", agent: "pi", cwd: dir },
			agent: { name: "red", type: "acp" },
			timestamp: new Date().toISOString(),
		};

		const result = await runAcpHook(scriptPath, {
			event: "task_failed",
			context,
			timeoutMs: 5000,
		});

		expect(result.exitCode).toBe(42);
		expect(result.success).toBe(false);
	});

	it("gracefully skips when no hook file exists (no error)", async () => {
		const missing = join(dir, "does-not-exist.sh");

		const context = {
			version: 1 as const,
			event: "session_idle" as const,
			source: "acp" as const,
			correlationId: "44444444-5555-6666-7777-888888888888",
			session: { id: "sess-4", agent: "pi", cwd: dir },
			agent: { name: "verifier", type: "acp" },
			timestamp: new Date().toISOString(),
		};

		const result = await runAcpHook(missing, {
			event: "session_idle",
			context,
			timeoutMs: 5000,
		});

		// graceful skip: not an error
		expect(result.skipped).toBe(true);
		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
	});

	it("discovers and runs multiple hooks for the same event", async () => {
		// two hooks side by side in the hooks dir
		const a = join(dir, "01-first.sh");
		const b = join(dir, "02-second.sh");
		writeFileSync(a, ["#!/usr/bin/env bash", "echo first", "exit 0", ""].join("\n"));
		writeFileSync(b, ["#!/usr/bin/env bash", "echo second", "exit 0", ""].join("\n"));
		chmodSync(a, 0o755);
		chmodSync(b, 0o755);

		const context = {
			version: 1 as const,
			event: "session_completed" as const,
			source: "acp" as const,
			correlationId: "55555555-6666-7777-8888-999999999999",
			session: { id: "sess-5", agent: "pi", cwd: dir },
			agent: { name: "pi", type: "acp" },
			timestamp: new Date().toISOString(),
		};

		// discovery helper: find all hook scripts for an event in a directory
		const results = await runAcpHook([a, b], {
			event: "session_completed",
			context,
			timeoutMs: 5000,
		});

		// runAcpHook accepts an array and returns aggregated results
		expect(Array.isArray(results.results)).toBe(true);
		expect(results.results).toHaveLength(2);
		const outs = results.results.map((r: { stdout: string }) => r.stdout).join("\n");
		expect(outs).toContain("first");
		expect(outs).toContain("second");
	});
});

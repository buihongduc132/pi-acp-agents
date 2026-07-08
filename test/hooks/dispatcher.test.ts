import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import type { HookConfig } from "../../src/hooks/types.js";

function makeConfig(overrides: Partial<HookConfig> = {}): HookConfig {
	return {
		version: 1,
		enabled: true,
		hooks: {
			task_completed: { enabled: true, timeoutMs: 5000 },
		},
		failureAction: "warn",
		followupOwner: "lead",
		maxReopensPerTask: 3,
		socket: {
			enabled: false,
			path: "/tmp/acp-hooks-test.sock",
			maxMessageSize: 1_048_576,
			broadcastTimeoutMs: 1000,
		},
		...overrides,
	};
}

function writeHook(dir: string, name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, body);
	chmodSync(p, 0o755);
	return p;
}

describe("HookDispatcher — 3-phase execution (LD6)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-disp-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("runs pre → parallel → aggregate phases in order", async () => {
		const order: string[] = [];
		const dispatcher = new HookDispatcher({
			config: makeConfig(),
			hooksDir: dir,
		});

		dispatcher.on({
			phase: "pre",
			event: "task_completed",
			handler: () => {
				order.push("pre");
				return {};
			},
		});

		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler: () => {
				order.push("post");
				return {};
			},
		});

		await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "11111111-1111-1111-1111-111111111111",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				timestamp: new Date().toISOString(),
			},
		});

		// pre must run before post
		const preIdx = order.indexOf("pre");
		const postIdx = order.indexOf("post");
		expect(preIdx).toBeGreaterThanOrEqual(0);
		expect(postIdx).toBeGreaterThanOrEqual(0);
		expect(preIdx).toBeLessThan(postIdx);
	});
});

describe("HookDispatcher — pre-hook blocking (LD13)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-disp-block-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("blockAll:true skips file + socket + post hooks", async () => {
		const ran = { file: false, post: false };
		writeHook(
			dir,
			"task_completed.sh",
			["#!/usr/bin/env bash", "echo ran", "exit 0", ""].join("\n"),
		);

		const dispatcher = new HookDispatcher({ config: makeConfig(), hooksDir: dir });

		dispatcher.on({
			phase: "pre",
			event: "task_completed",
			handler: () => ({ blockAll: true, reason: "maintenance" }),
		});
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler: () => {
				ran.post = true;
				return {};
			},
		});

		const result = await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "22222222-2222-2222-2222-222222222222",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				timestamp: new Date().toISOString(),
			},
		});

		// file hook result empty / skipped
		expect(result.fileResults).toHaveLength(0);
		// post hooks not run
		expect(ran.post).toBe(false);
		// block reason recorded
		expect(result.blocked).toBe(true);
		expect(result.blockReason).toBe("maintenance");
	});

	it("suppress:['file'] skips only file hooks, runs post hooks", async () => {
		const ran = { post: false };
		writeHook(
			dir,
			"task_completed.sh",
			["#!/usr/bin/env bash", "echo ran", "exit 0", ""].join("\n"),
		);

		const dispatcher = new HookDispatcher({ config: makeConfig(), hooksDir: dir });

		dispatcher.on({
			phase: "pre",
			event: "task_completed",
			handler: () => ({ suppress: ["file"] }),
		});
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler: () => {
				ran.post = true;
				return {};
			},
		});

		const result = await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "33333333-3333-3333-3333-333333333333",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				timestamp: new Date().toISOString(),
			},
		});

		expect(result.fileResults).toHaveLength(0);
		expect(ran.post).toBe(true);
		expect(result.blocked).toBe(false);
	});
});

describe("HookDispatcher — parallel dispatch", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-disp-par-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("runs file hooks + socket + post-hooks in parallel", async () => {
		// two file hooks that each sleep — combined time < sum
		writeHook(
			dir,
			"a.sh",
			["#!/usr/bin/env bash", "sleep 0.3", "exit 0", ""].join("\n"),
		);
		writeHook(
			dir,
			"b.sh",
			["#!/usr/bin/env bash", "sleep 0.3", "exit 0", ""].join("\n"),
		);

		const dispatcher = new HookDispatcher({
			config: makeConfig({
				socket: {
					enabled: true,
					path: "/tmp/acp-hooks-par.sock",
					maxMessageSize: 1_048_576,
					broadcastTimeoutMs: 1000,
				},
			}),
			hooksDir: dir,
		});

		const postRun = vi.fn();
		dispatcher.on({
			phase: "post",
			event: "task_completed",
			handler: () => {
				postRun();
				return {};
			},
		});

		const start = Date.now();
		await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "44444444-4444-4444-4444-444444444444",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				timestamp: new Date().toISOString(),
			},
		});
		const elapsed = Date.now() - start;

		expect(postRun).toHaveBeenCalledTimes(1);
		// if serial, would be ≥600ms; parallel < 500ms
		expect(elapsed).toBeLessThan(550);
	});

	it("file hooks respect per-event timeoutMs", async () => {
		writeHook(
			dir,
			"slow.sh",
			["#!/usr/bin/env bash", "sleep 5", "exit 0", ""].join("\n"),
		);

		const dispatcher = new HookDispatcher({
			config: makeConfig({
				hooks: {
					task_completed: { enabled: true, timeoutMs: 300 },
				},
			}),
			hooksDir: dir,
		});

		const start = Date.now();
		const result = await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "55555555-5555-5555-5555-555555555555",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				timestamp: new Date().toISOString(),
			},
		});
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(2000);
		expect(result.fileResults.some((r) => r.timedOut)).toBe(true);
	});
});

describe("HookDispatcher — aggregation & exception isolation", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-disp-agg-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("collects file hook exit codes", async () => {
		writeHook(
			dir,
			"ok.sh",
			["#!/usr/bin/env bash", "exit 0", ""].join("\n"),
		);
		writeHook(
			dir,
			"bad.sh",
			["#!/usr/bin/env bash", "exit 7", ""].join("\n"),
		);

		const dispatcher = new HookDispatcher({ config: makeConfig(), hooksDir: dir });

		const result = await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "66666666-6666-6666-6666-666666666666",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				timestamp: new Date().toISOString(),
			},
		});

		expect(result.fileResults).toHaveLength(2);
		const exitCodes = result.fileResults.map((r) => r.exitCode).sort();
		expect(exitCodes).toEqual([0, 7]);
		expect(result.hasFailures).toBe(true);
	});

	it("applies failure policy on failure (warn)", async () => {
		writeHook(
			dir,
			"bad.sh",
			["#!/usr/bin/env bash", "exit 1", ""].join("\n"),
		);

		const applyFailurePolicy = vi.fn().mockReturnValue({ handled: true, action: "warn" });
		const dispatcher = new HookDispatcher({
			config: makeConfig({ failureAction: "warn" }),
			hooksDir: dir,
			applyFailurePolicy,
		});

		const result = await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "77777777-7777-7777-7777-777777777777",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				task: { id: "t-1", subject: "s", status: "completed" },
				timestamp: new Date().toISOString(),
			},
		});

		expect(applyFailurePolicy).toHaveBeenCalled();
		expect(result.policyApplied).toBe(true);
	});

	it("exception isolation: one failing file hook doesn't crash others", async () => {
		writeHook(
			dir,
			"crash.sh",
			["#!/usr/bin/env bash", "exit 99", ""].join("\n"),
		);
		writeHook(
			dir,
			"good.sh",
			["#!/usr/bin/env bash", "echo ok", "exit 0", ""].join("\n"),
		);

		const dispatcher = new HookDispatcher({
			config: makeConfig({ failureAction: "warn" }),
			hooksDir: dir,
		});

		const result = await dispatcher.dispatch({
			event: "task_completed",
			context: {
				version: 1,
				event: "task_completed",
				source: "acp",
				correlationId: "88888888-8888-8888-8888-888888888888",
				session: { id: "s", agent: "pi", cwd: dir },
				agent: { name: "coder", type: "acp" },
				timestamp: new Date().toISOString(),
			},
		});

		// both hooks ran despite the crash
		expect(result.fileResults).toHaveLength(2);
		const goodResult = result.fileResults.find(
			(r) => r.stdout?.includes("ok"),
		);
		expect(goodResult).toBeDefined();
		expect(goodResult!.exitCode).toBe(0);
	});
});

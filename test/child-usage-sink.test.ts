/**
 * child-usage sink — TDD tests (RED phase).
 *
 * Mirrors worker usage to a shared sink file so external apps can read ACP
 * child-agent token/duration data from ONE place:
 *   <sinkDir>/<childSessionId>.json
 *
 * Canonical schema:
 *   flow/findings/2026-07-17-unify-child-usage/solutions/child-usage-schema-contract.md
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	writeChildUsage,
	readChildUsage,
	getChildUsageDir,
} from "../src/management/child-usage-sink.js";
import { WorkerStore } from "../src/management/worker-store.js";

// ── vi.mock for node:fs — lets specific tests force writeFileSync to throw ──
// to simulate mid-write FS failure (ESM named imports are not configurable,
// so vi.spyOn on the namespace is rejected — vi.mock is the supported path).
const { shouldThrowOnWriteRef } = vi.hoisted(() => ({ shouldThrowOnWriteRef: { v: false } }));
vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			if (shouldThrowOnWriteRef.v) {
				throw new Error("simulated disk full");
			}
			return actual.writeFileSync(...args);
		},
	};
});

describe("child-usage sink", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeSinkDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "acp-child-usage-"));
		dirs.push(dir);
		const sink = join(dir, "child-usage");
		mkdirSync(sink, { recursive: true });
		return sink;
	}

	it("getChildUsageDir honors explicit override", () => {
		const explicit = "/tmp/explicit-acp-child-usage-dir";
		expect(getChildUsageDir(explicit)).toBe(explicit);
	});

	it("materializes a sink file after writeChildUsage", () => {
		const dir = makeSinkDir();
		writeChildUsage(
			{
				childSessionId: "child-1",
				parentSessionId: "parent-1",
				source: "acp",
				tokensTotal: 42,
				toolCalls: 3,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		const file = join(dir, "child-1.json");
		expect(existsSync(file)).toBe(true);
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		expect(parsed.tokensTotal).toBe(42);
		expect(parsed.toolCalls).toBe(3);
		expect(parsed.childSessionId).toBe("child-1");
	});

	it("writes the full schema with correct field names + types", () => {
		const dir = makeSinkDir();
		writeChildUsage(
			{
				childSessionId: "child-schema",
				parentSessionId: "parent-schema",
				source: "acp",
				tokensTotal: 10,
				toolCalls: 2,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		const rec = readChildUsage("child-schema", { dir });
		expect(rec).toEqual(
			expect.objectContaining({
				schemaVersion: 1,
				childSessionId: "child-schema",
				parentSessionId: "parent-schema",
				source: "acp",
				tokensTotal: 10,
				toolCalls: 2,
				turns: 0,
				durationScope: "wallclock",
				startedAt: "2026-07-17T12:00:00.000Z",
			}),
		);
		expect(typeof rec!.updatedAt).toBe("string");
		expect(rec!.endedAt).toBeNull();
		expect(rec!.durationMs).toBe(0);
	});

	it("marks source = 'acp'", () => {
		const dir = makeSinkDir();
		writeChildUsage(
			{
				childSessionId: "child-src",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 0,
				toolCalls: 0,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		expect(readChildUsage("child-src", { dir })!.source).toBe("acp");
	});

	it("schemaVersion = 1 is present", () => {
		const dir = makeSinkDir();
		writeChildUsage(
			{
				childSessionId: "child-ver",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 0,
				toolCalls: 0,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		expect(readChildUsage("child-ver", { dir })!.schemaVersion).toBe(1);
	});

	it("uses ABSOLUTE totals (not deltas) — latest write wins", () => {
		const dir = makeSinkDir();
		writeChildUsage(
			{
				childSessionId: "child-abs",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 5,
				toolCalls: 1,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		writeChildUsage(
			{
				childSessionId: "child-abs",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 7, // absolute, NOT 5+7
				toolCalls: 2,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		const rec = readChildUsage("child-abs", { dir })!;
		expect(rec.tokensTotal).toBe(7);
		expect(rec.toolCalls).toBe(2);
	});

	it("idempotent merge preserves foreign fields another writer may have set", () => {
		const dir = makeSinkDir();
		// Pre-seed a file with fields ACP does NOT own (simulating another writer).
		writeFileSync(
			join(dir, "child-merge.json"),
			JSON.stringify({
				schemaVersion: 1,
				childSessionId: "child-merge",
				parentSessionId: null,
				source: "teams",
				tokensTotal: 999,
				toolCalls: 999,
				turns: 7,
				durationMs: 1000,
				durationScope: "wallclock",
				startedAt: "2026-07-17T11:00:00.000Z",
				updatedAt: "2026-07-17T11:05:00.000Z",
				endedAt: null,
				customExternalField: "do-not-touch", // foreign
			}),
			"utf-8",
		);

		writeChildUsage(
			{
				childSessionId: "child-merge",
				parentSessionId: "parent-merge",
				source: "acp",
				tokensTotal: 100,
				toolCalls: 4,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);

		const rec = JSON.parse(readFileSync(join(dir, "child-merge.json"), "utf-8"));
		// ACP-owned fields overwritten:
		expect(rec.source).toBe("acp");
		expect(rec.tokensTotal).toBe(100);
		expect(rec.toolCalls).toBe(4);
		expect(rec.parentSessionId).toBe("parent-merge");
		// Foreign field preserved (NOT nulled):
		expect(rec.customExternalField).toBe("do-not-touch");
	});

	it("writes endedAt + durationMs when endedAt is provided", () => {
		const dir = makeSinkDir();
		writeChildUsage(
			{
				childSessionId: "child-end",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 10,
				toolCalls: 1,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		writeChildUsage(
			{
				childSessionId: "child-end",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 10,
				toolCalls: 1,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
				endedAt: "2026-07-17T12:05:00.000Z", // +5 min = 300_000ms
			},
			{ dir },
		);
		const rec = readChildUsage("child-end", { dir })!;
		expect(rec.endedAt).toBe("2026-07-17T12:05:00.000Z");
		expect(rec.durationMs).toBe(300_000);
	});

	it("endedAt write does NOT null-out foreign fields either", () => {
		const dir = makeSinkDir();
		writeFileSync(
			join(dir, "child-end2.json"),
			JSON.stringify({
				schemaVersion: 1,
				childSessionId: "child-end2",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 1,
				toolCalls: 1,
				turns: 0,
				durationMs: 0,
				durationScope: "wallclock",
				startedAt: "2026-07-17T12:00:00.000Z",
				updatedAt: "2026-07-17T12:00:00.000Z",
				endedAt: null,
				externalNote: "keep-me",
			}),
			"utf-8",
		);
		writeChildUsage(
			{
				childSessionId: "child-end2",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 1,
				toolCalls: 1,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
				endedAt: "2026-07-17T12:01:00.000Z",
			},
			{ dir },
		);
		const rec = JSON.parse(readFileSync(join(dir, "child-end2.json"), "utf-8"));
		expect(rec.externalNote).toBe("keep-me");
		expect(rec.endedAt).toBe("2026-07-17T12:01:00.000Z");
	});

	it("atomic write: on simulated mid-write failure, no torn/partial .json is left", () => {
		const dir = makeSinkDir();
		// Seed a valid existing file so we can prove it is NOT corrupted.
		writeFileSync(
			join(dir, "child-atomic.json"),
			JSON.stringify({
				schemaVersion: 1,
				childSessionId: "child-atomic",
				tokensTotal: 1,
			}),
			"utf-8",
		);

		// Force writeFileSync to throw to simulate mid-write FS failure.
		shouldThrowOnWriteRef.v = true;
		try {
			// Must NOT throw — non-blocking.
			expect(() =>
				writeChildUsage(
					{
						childSessionId: "child-atomic",
						parentSessionId: null,
						source: "acp",
						tokensTotal: 50,
						toolCalls: 1,
						turns: 0,
						startedAt: "2026-07-17T12:00:00.000Z",
					},
					{ dir },
				),
			).not.toThrow();
		} finally {
			shouldThrowOnWriteRef.v = false;
		}

		// Original file intact (NOT torn/corrupted).
		const parsed = JSON.parse(readFileSync(join(dir, "child-atomic.json"), "utf-8"));
		expect(parsed.tokensTotal).toBe(1);
		// No .tmp leftover.
		expect(readdirSync(dir)).not.toContain("child-atomic.json.tmp");
	});

	it("FS error is swallowed — never escapes the runtime", () => {
		const dir = makeSinkDir();
		shouldThrowOnWriteRef.v = true;
		try {
			expect(() =>
				writeChildUsage(
					{
						childSessionId: "child-err",
						parentSessionId: null,
						source: "acp",
						tokensTotal: 1,
						toolCalls: 1,
						turns: 0,
						startedAt: "2026-07-17T12:00:00.000Z",
					},
					{ dir },
				),
			).not.toThrow();
		} finally {
			shouldThrowOnWriteRef.v = false;
		}
	});

	it("skips write when childSessionId is empty/missing (never fabricate)", () => {
		const dir = makeSinkDir();
		// Empty string is a valid `string` but sink must skip writes for it
		// (never fabricate a childSessionId).
		writeChildUsage(
			{
				childSessionId: "",
				parentSessionId: null,
				source: "acp",
				tokensTotal: 1,
				toolCalls: 1,
				turns: 0,
				startedAt: "2026-07-17T12:00:00.000Z",
			},
			{ dir },
		);
		expect(existsSync(join(dir, ".json"))).toBe(false);
		expect(readdirSync(dir).length).toBe(0);
	});
});

describe("child-usage sink — WorkerStore integration", () => {
	const dirs: string[] = [];
	let prevEnv: string | undefined;

	beforeEach(() => {
		const sinkDir = mkdtempSync(join(tmpdir(), "acp-child-usage-int-"));
		dirs.push(sinkDir);
		prevEnv = process.env.PI_ACP_CHILD_USAGE_DIR;
		process.env.PI_ACP_CHILD_USAGE_DIR = join(sinkDir, "child-usage");
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.PI_ACP_CHILD_USAGE_DIR;
		else process.env.PI_ACP_CHILD_USAGE_DIR = prevEnv;
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("touch() materializes sink file with absolute token/tool totals", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "acp-ws-int-"));
		dirs.push(rootDir);
		const store = new WorkerStore(rootDir, "parent-session-1");
		store.register({ name: "w1", sessionId: "child-session-1", agentName: "gemini" });

		store.touch("w1", { tokenDelta: 10, toolCallDelta: 1 });
		store.touch("w1", { tokenDelta: 5, toolCallDelta: 1 });

		const sinkDir = process.env.PI_ACP_CHILD_USAGE_DIR!;
		const rec = readChildUsage("child-session-1", { dir: sinkDir });
		expect(rec).not.toBeNull();
		expect(rec!.tokensTotal).toBe(15); // absolute, not delta
		expect(rec!.toolCalls).toBe(2);
		expect(rec!.source).toBe("acp");
		expect(rec!.schemaVersion).toBe(1);
		expect(rec!.parentSessionId).toBe("parent-session-1");
		expect(rec!.startedAt).toBeTruthy();
		expect(rec!.endedAt).toBeNull();
	});

	it("unregister() writes endedAt + durationMs", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "acp-ws-int-"));
		dirs.push(rootDir);
		const store = new WorkerStore(rootDir, "parent-session-2");
		store.register({ name: "w2", sessionId: "child-session-2", agentName: "codex" });
		store.touch("w2", { tokenDelta: 3 });

		store.unregister("w2");

		const sinkDir = process.env.PI_ACP_CHILD_USAGE_DIR!;
		const rec = readChildUsage("child-session-2", { dir: sinkDir });
		expect(rec).not.toBeNull();
		expect(rec!.endedAt).not.toBeNull();
		expect(rec!.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("updateStatus(name,'offline') writes endedAt + durationMs (terminal)", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "acp-ws-int-"));
		dirs.push(rootDir);
		const store = new WorkerStore(rootDir, "parent-session-3");
		store.register({ name: "w3", sessionId: "child-session-3", agentName: "opencode" });
		store.touch("w3", { tokenDelta: 1 });

		store.updateStatus("w3", "offline");

		const sinkDir = process.env.PI_ACP_CHILD_USAGE_DIR!;
		const rec = readChildUsage("child-session-3", { dir: sinkDir });
		expect(rec).not.toBeNull();
		expect(rec!.endedAt).not.toBeNull();
		expect(rec!.durationMs).toBeGreaterThanOrEqual(0);
	});
});

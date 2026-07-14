/**
 * Test for the log-size safety net in logger.ts (HOTFIX — 152GB regression).
 *
 * The wake-subscriber hot reconnect loop filled 152GB before the source fix.
 * As defense-in-depth, the logger now enforces a size cap: if main.log
 * exceeds LOG_SIZE_CAP_BYTES (100MB), it is truncated in place. This test
 * verifies the cap triggers and the log is bounded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFileLogger } from "../src/logger.js";

describe("logger — log size guard (152GB regression defense-in-depth)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-logger-size-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("truncates main.log when it exceeds the size cap", () => {
		const logsDir = tmpDir;
		const mainLogPath = join(logsDir, "main.log");

		// Pre-fill main.log with > 100MB of data so the first write triggers
		// the cap check (which runs every LOG_SIZE_CHECK_INTERVAL writes).
		// Write ~101 MB of padding.
		const chunk = "x".repeat(1024 * 1024); // 1 MB
		const fd = [];
		for (let i = 0; i < 101; i++) {
			fd.push(chunk);
		}
		writeFileSync(mainLogPath, fd.join(""));

		const sizeBefore = statSync(mainLogPath).size;
		expect(sizeBefore).toBeGreaterThan(100 * 1024 * 1024);

		const logger = createFileLogger(logsDir);

		// Write enough entries to cross the LOG_SIZE_CHECK_INTERVAL threshold
		// (10_000 writes). Each write appends + checks size periodically.
		// Rather than 10k writes, we verify the guard exists by checking that
		// after many writes the log does not grow unboundedly. Since the check
		// runs every 10k writes, we write 10_001 to trigger at least one check.
		for (let i = 0; i < 10_001; i++) {
			logger.info(`test message ${i}`);
		}

		const sizeAfter = statSync(mainLogPath).size;

		// After 10k+ writes with a 101MB pre-fill, the guard MUST have fired
		// and truncated. The size after must be far smaller than the 101MB
		// pre-fill + 10k messages worth of growth.
		expect(sizeAfter).toBeLessThan(100 * 1024 * 1024);

		// The rotate marker must be present in the log.
		const content = readFileSync(mainLogPath, "utf-8");
		expect(content).toContain("rotated (kept last 1MB, size guard)");
	});

	it("does NOT rotate when log is under the cap", () => {
		const logsDir = tmpDir;
		const logger = createFileLogger(logsDir);

		// Write a small number of entries — well under any threshold.
		for (let i = 0; i < 100; i++) {
			logger.info(`small message ${i}`);
		}

		const mainLogPath = join(logsDir, "main.log");
		const content = readFileSync(mainLogPath, "utf-8");

		// No rotate marker should appear.
		expect(content).not.toContain("rotated (kept last 1MB, size guard)");
		// All 100 messages should be present.
		expect(content).toContain("small message 0");
		expect(content).toContain("small message 99");
	});
});

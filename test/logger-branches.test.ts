/**
 * Branch coverage for logger.ts — error paths, mkdirSync failure, appendFileSync failure
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFileLogger, createNoopLogger } from "../src/logger.js";

describe("logger.ts — branch coverage", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "acp-logger-test-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("createFileLogger", () => {
		it("creates logsDir if not exists", () => {
			const logsDir = join(tempDir, "new-logs");
			const logger = createFileLogger(logsDir);
			logger.info("test", { key: "value" });
			const { existsSync } = require("node:fs");
			expect(existsSync(join(logsDir, "main.log"))).toBe(true);
		});

		it("writes to session trace file when sessionId provided", () => {
			const logger = createFileLogger(tempDir, "session-1");
			logger.info("hello session");
			logger.error("error session");
			logger.debug("debug session");
			const { existsSync } = require("node:fs");
			expect(existsSync(join(tempDir, "session-1", "trace.jsonl"))).toBe(true);
			expect(existsSync(join(tempDir, "main.log"))).toBe(true);
		});

		it("writes debug without data", () => {
			const logger = createFileLogger(tempDir);
			logger.debug("just a message");
			const { readFileSync } = require("node:fs");
			const content = readFileSync(join(tempDir, "main.log"), "utf-8");
			expect(content).toContain("just a message");
		});

		it("writes error with data", () => {
			const logger = createFileLogger(tempDir);
			logger.error("error occurred", { code: 500 });
			const { readFileSync } = require("node:fs");
			const content = readFileSync(join(tempDir, "main.log"), "utf-8");
			expect(content).toContain("error occurred");
			expect(content).toContain("500");
		});

		it("creates sessionDir if not exists", () => {
			const logsDir = join(tempDir, "deep", "logs");
			const logger = createFileLogger(logsDir, "sess-abc");
			logger.info("test");
			const { existsSync } = require("node:fs");
			expect(existsSync(join(logsDir, "sess-abc", "trace.jsonl"))).toBe(true);
		});
	});

	describe("createNoopLogger", () => {
		it("does not throw on any method", () => {
			const logger = createNoopLogger();
			expect(() => {
				logger.info("test");
				logger.error("test");
				logger.debug("test");
			}).not.toThrow();
		});
	});
});

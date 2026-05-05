/**
 * RED tests for logger module.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFileLogger, createNoopLogger } from "../src/logger.js";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = join(tmpdir(), "pi-acp-agents-test-logs");

describe("logger", () => {
	beforeEach(() => {
		mkdirSync(TMP_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TMP_DIR, { recursive: true, force: true });
	});

	describe("createNoopLogger", () => {
		it("returns a logger with info/error/debug methods", () => {
			const logger = createNoopLogger();
			expect(typeof logger.info).toBe("function");
			expect(typeof logger.error).toBe("function");
			expect(typeof logger.debug).toBe("function");
		});

		it("does not throw on any method", () => {
			const logger = createNoopLogger();
			expect(() => logger.info("test")).not.toThrow();
			expect(() => logger.error("test")).not.toThrow();
			expect(() => logger.debug("test")).not.toThrow();
		});
	});

	describe("createFileLogger", () => {
		it("creates a logger that writes to files", () => {
			const logger = createFileLogger(TMP_DIR);
			logger.info("test message", { key: "value" });
			expect(existsSync(join(TMP_DIR, "main.log"))).toBe(true);
		});

		it("writes JSON lines", () => {
			const logger = createFileLogger(TMP_DIR);
			logger.info("hello");
			const content = readFileSync(join(TMP_DIR, "main.log"), "utf-8");
			const lines = content.trim().split("\n");
			expect(lines.length).toBe(1);
			const entry = JSON.parse(lines[0]);
			expect(entry.level).toBe("info");
			expect(entry.msg).toBe("hello");
		});

		it("creates session subdirectory when sessionId provided", () => {
			const logger = createFileLogger(TMP_DIR, "sess-123");
			logger.info("session log");
			expect(existsSync(join(TMP_DIR, "sess-123", "trace.jsonl"))).toBe(true);
		});
	});
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFileLogger, createNoopLogger } from "../src/logger.js";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = join(tmpdir(), "pi-acp-agents-test-logs-ext");

describe("logger (extended)", () => {
	beforeEach(() => {
		mkdirSync(TMP_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TMP_DIR, { recursive: true, force: true });
	});

	describe("createFileLogger", () => {
		it("writes error level messages", () => {
			const logger = createFileLogger(TMP_DIR);
			logger.error("error msg", { code: 500 });
			const content = readFileSync(join(TMP_DIR, "main.log"), "utf-8");
			const entry = JSON.parse(content.trim());
			expect(entry.level).toBe("error");
			expect(entry.msg).toBe("error msg");
			expect(entry.data).toEqual({ code: 500 });
		});

		it("writes debug level messages", () => {
			const logger = createFileLogger(TMP_DIR);
			logger.debug("debug msg");
			const content = readFileSync(join(TMP_DIR, "main.log"), "utf-8");
			const entry = JSON.parse(content.trim());
			expect(entry.level).toBe("debug");
		});

		it("omits data field when not provided", () => {
			const logger = createFileLogger(TMP_DIR);
			logger.info("no data");
			const content = readFileSync(join(TMP_DIR, "main.log"), "utf-8");
			const entry = JSON.parse(content.trim());
			expect(entry).not.toHaveProperty("data");
		});

		it("includes timestamp in entries", () => {
			const logger = createFileLogger(TMP_DIR);
			logger.info("ts test");
			const content = readFileSync(join(TMP_DIR, "main.log"), "utf-8");
			const entry = JSON.parse(content.trim());
			expect(entry.timestamp).toBeDefined();
			expect(() => new Date(entry.timestamp)).not.toThrow();
		});

		it("creates logsDir when it does not exist", () => {
			const newDir = join(TMP_DIR, "new", "nested");
			const logger = createFileLogger(newDir);
			logger.info("creates dir");
			expect(existsSync(join(newDir, "main.log"))).toBe(true);
		});

		it("session logger writes to both main.log and trace.jsonl", () => {
			const logger = createFileLogger(TMP_DIR, "sess-456");
			logger.info("dual write");
			const main = readFileSync(join(TMP_DIR, "main.log"), "utf-8");
			const trace = readFileSync(join(TMP_DIR, "sess-456", "trace.jsonl"), "utf-8");
			expect(main).toContain("dual write");
			expect(trace).toContain("dual write");
		});

		it("session logger error writes to trace.jsonl", () => {
			const logger = createFileLogger(TMP_DIR, "sess-err");
			logger.error("session error", { details: "fail" });
			const trace = readFileSync(join(TMP_DIR, "sess-err", "trace.jsonl"), "utf-8");
			const entry = JSON.parse(trace.trim());
			expect(entry.level).toBe("error");
			expect(entry.data).toEqual({ details: "fail" });
		});

		it("session logger debug writes to trace.jsonl", () => {
			const logger = createFileLogger(TMP_DIR, "sess-dbg");
			logger.debug("session debug");
			const trace = readFileSync(join(TMP_DIR, "sess-dbg", "trace.jsonl"), "utf-8");
			const entry = JSON.parse(trace.trim());
			expect(entry.level).toBe("debug");
		});

		it("handles multiple writes correctly", () => {
			const logger = createFileLogger(TMP_DIR);
			logger.info("msg1");
			logger.error("msg2");
			logger.debug("msg3");
			const content = readFileSync(join(TMP_DIR, "main.log"), "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(3);
			expect(JSON.parse(lines[0]).level).toBe("info");
			expect(JSON.parse(lines[1]).level).toBe("error");
			expect(JSON.parse(lines[2]).level).toBe("debug");
		});

		it("session logger creates session subdirectory", () => {
			const logger = createFileLogger(TMP_DIR, "new-sess");
			logger.info("test");
			expect(existsSync(join(TMP_DIR, "new-sess"))).toBe(true);
			expect(existsSync(join(TMP_DIR, "new-sess", "trace.jsonl"))).toBe(true);
		});
	});
});

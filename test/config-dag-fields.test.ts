import { describe, it, expect } from "vitest";
import {
	validateConfig,
	DEFAULT_CONFIG,
} from "../src/config/config.js";

describe("AcpConfig DAG fields (task 1.2)", () => {
	describe("DEFAULT_CONFIG", () => {
		it("exposes dagStaleTimeoutMs default of 3_600_000", () => {
			expect(DEFAULT_CONFIG.dagStaleTimeoutMs).toBe(3_600_000);
		});

		it("exposes dagOutputTruncateChars default of 8000", () => {
			expect(DEFAULT_CONFIG.dagOutputTruncateChars).toBe(8000);
		});
	});

	describe("validateConfig", () => {
		it("applies DAG defaults when fields are omitted", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
			});
			expect(config.dagStaleTimeoutMs).toBe(3_600_000);
			expect(config.dagOutputTruncateChars).toBe(8000);
		});

		it("honors explicit DAG field overrides", () => {
			const config = validateConfig({
				agent_servers: { gemini: { command: "gemini" } },
				dagStaleTimeoutMs: 7_200_000,
				dagOutputTruncateChars: 4000,
			});
			expect(config.dagStaleTimeoutMs).toBe(7_200_000);
			expect(config.dagOutputTruncateChars).toBe(4000);
		});
	});
});

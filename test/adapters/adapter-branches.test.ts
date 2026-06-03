import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock console.debug to avoid noise
const origConsoleDebug = console.debug;
const mockConsoleDebug = vi.fn();
beforeEach(() => { console.debug = mockConsoleDebug; });
afterEach(() => { console.debug = origConsoleDebug; });

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { GeminiAcpAdapter } from "../../src/adapters/gemini.js";
import { CodexAcpAdapter } from "../../src/adapters/codex.js";
import { OpenCodeAcpAdapter } from "../../src/adapters/opencode.js";
import { execSync } from "node:child_process";

const mockExec = execSync as ReturnType<typeof vi.fn>;

describe("adapters — catch branches", () => {
	afterEach(() => {
	});

	describe("GeminiAcpAdapter.isAvailable catch branch", () => {
		it("logs debug when gemini not found", () => {
			mockExec.mockImplementation((cmd: string) => {
				throw new Error("not found");
			});
			const result = GeminiAcpAdapter.isAvailable();
			expect(result).toBe(false);
			expect(mockConsoleDebug).toHaveBeenCalled();
		});
	});

	describe("GeminiAcpAdapter.getVersion catch branch", () => {
		it("logs debug when version check fails", () => {
			mockExec.mockImplementation((cmd: string) => {
				throw new Error("version failed");
			});
			const result = GeminiAcpAdapter.getVersion();
			expect(result).toBeNull();
			expect(mockConsoleDebug).toHaveBeenCalled();
		});
	});

	describe("CodexAcpAdapter", () => {
		it("applyDefaults fills command when empty", () => {
			const adapter = new CodexAcpAdapter({});
			const defaults = (adapter as any).applyDefaults({ command: "", args: undefined } as any);
			expect(defaults.command).toBe("codex-acp");
			expect(defaults.args).toEqual([]);
		});
	});

	describe("OpenCodeAcpAdapter", () => {
		it("constructor falls back to 'opencode' when resolveBinary returns null", () => {
			mockExec.mockImplementation(() => { throw new Error("not found"); });
			const adapter = new OpenCodeAcpAdapter({});
			expect(adapter["config"].command).toBe("opencode");
		});
	});
});

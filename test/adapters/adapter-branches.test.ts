import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDebug } = vi.hoisted(() => ({ mockDebug: vi.fn() }));
vi.mock("../../src/logger.js", () => ({
	createNoopLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: mockDebug }),
	createFileLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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
			expect(mockDebug).toHaveBeenCalled();
		});
	});

	describe("GeminiAcpAdapter.getVersion catch branch", () => {
		it("logs debug when version check fails", () => {
			mockExec.mockImplementation((cmd: string) => {
				throw new Error("version failed");
			});
			const result = GeminiAcpAdapter.getVersion();
			expect(result).toBeNull();
			expect(mockDebug).toHaveBeenCalled();
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

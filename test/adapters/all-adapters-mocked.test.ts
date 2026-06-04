import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { GeminiAcpAdapter } from "../../src/adapters/gemini.js";
import { CodexAcpAdapter } from "../../src/adapters/codex.js";
import { OpenCodeAcpAdapter } from "../../src/adapters/opencode.js";

import { execSync } from "node:child_process";

const mockExec = execSync as ReturnType<typeof vi.fn>;

describe("adapters/gemini (mocked)", () => {
	beforeEach(() => {
	});

	describe("isAvailable", () => {
		it("returns true when gemini is found on PATH", () => {
			mockExec.mockReturnValue(Buffer.from("/usr/bin/gemini"));
			expect(GeminiAcpAdapter.isAvailable()).toBe(true);
			expect(mockExec).toHaveBeenCalledWith("which gemini", { stdio: "pipe" });
		});

		it("returns false when gemini is not found", () => {
			mockExec.mockImplementation(() => { throw new Error("not found"); });
			expect(GeminiAcpAdapter.isAvailable()).toBe(false);
		});
	});

	describe("getVersion", () => {
		it("returns version string when command succeeds", () => {
			mockExec.mockReturnValue("gemini 1.2.3\n");
			expect(GeminiAcpAdapter.getVersion()).toBe("gemini 1.2.3");
			expect(mockExec).toHaveBeenCalledWith("gemini --version", { encoding: "utf-8", stdio: "pipe" });
		});

		it("returns null when command fails", () => {
			mockExec.mockImplementation(() => { throw new Error("failed"); });
			expect(GeminiAcpAdapter.getVersion()).toBe(null);
		});
	});

	describe("constructor", () => {
		it("provides default config", () => {
			const adapter = new GeminiAcpAdapter({});
			expect(adapter.name).toBe("gemini");
			expect(adapter["config"].command).toBe("gemini");
			expect(adapter["config"].args).toEqual(["--acp"]);
		});

		it("overrides defaults with user config", () => {
			const adapter = new GeminiAcpAdapter({
				config: { command: "custom-gemini", args: ["--acp", "--sandbox"] },
			});
			expect(adapter["config"].command).toBe("custom-gemini");
			expect(adapter["config"].args).toEqual(["--acp", "--sandbox"]);
		});

		it("applies default args when not specified", () => {
			const adapter = new GeminiAcpAdapter({ config: { command: "my-gemini" } });
			expect(adapter["config"].args).toEqual(["--acp"]);
		});
	});
});

describe("adapters/codex (mocked)", () => {
	beforeEach(() => {
	});

	describe("isAvailable", () => {
		it("returns true when codex-acp is found", () => {
			mockExec.mockReturnValue(Buffer.from("/usr/bin/codex-acp"));
			expect(CodexAcpAdapter.isAvailable()).toBe(true);
			expect(mockExec).toHaveBeenCalledWith("which codex-acp", { stdio: "pipe" });
		});

		it("returns false when not found", () => {
			mockExec.mockImplementation(() => { throw new Error("not found"); });
			expect(CodexAcpAdapter.isAvailable()).toBe(false);
		});
	});

	describe("getVersion", () => {
		it("returns version string on success", () => {
			mockExec.mockReturnValue("codex-acp 0.5.0\n");
			expect(CodexAcpAdapter.getVersion()).toBe("codex-acp 0.5.0");
		});

		it("returns null on failure", () => {
			mockExec.mockImplementation(() => { throw new Error("failed"); });
			expect(CodexAcpAdapter.getVersion()).toBe(null);
		});
	});

	describe("constructor", () => {
		it("provides default config", () => {
			const adapter = new CodexAcpAdapter({});
			expect(adapter.name).toBe("codex");
			expect(adapter["config"].command).toBe("codex-acp");
			expect(adapter["config"].args).toEqual([]);
		});

		it("overrides defaults", () => {
			const adapter = new CodexAcpAdapter({
				config: { command: "my-codex", args: ["--flag"] },
			});
			expect(adapter["config"].command).toBe("my-codex");
			expect(adapter["config"].args).toEqual(["--flag"]);
		});
	});
});

describe("adapters/opencode (mocked)", () => {
	beforeEach(() => {
	});

	describe("isAvailable", () => {
		it("returns true when opencode is found", () => {
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("opencode")) return Buffer.from("/usr/bin/opencode");
				throw new Error("not found");
			});
			expect(OpenCodeAcpAdapter.isAvailable()).toBe(true);
		});

		it("returns true when ocxo is found", () => {
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("ocxo")) return Buffer.from("/usr/bin/ocxo");
				throw new Error("not found");
			});
			expect(OpenCodeAcpAdapter.isAvailable()).toBe(true);
		});

		it("returns false when neither is found", () => {
			mockExec.mockImplementation(() => { throw new Error("not found"); });
			expect(OpenCodeAcpAdapter.isAvailable()).toBe(false);
		});

		it("accepts custom binary parameter", () => {
			mockExec.mockReturnValue(Buffer.from("/custom/bin"));
			expect(OpenCodeAcpAdapter.isAvailable("custom-bin")).toBe(true);
			expect(mockExec).toHaveBeenCalledWith("which custom-bin", { stdio: "pipe" });
		});
	});

	describe("getVersion", () => {
		it("returns version string with binary prefix", () => {
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("opencode")) return "v2.0\n";
				throw new Error("not found");
			});
			expect(OpenCodeAcpAdapter.getVersion()).toBe("opencode: v2.0");
		});

		it("returns version with ocxo when opencode fails", () => {
			let callCount = 0;
			mockExec.mockImplementation((cmd: string) => {
				callCount++;
				if (cmd.includes("opencode")) throw new Error("not found");
				if (cmd.includes("ocxo")) return "v3.0\n";
				throw new Error("not found");
			});
			expect(OpenCodeAcpAdapter.getVersion()).toBe("ocxo: v3.0");
		});

		it("returns null when all candidates fail", () => {
			mockExec.mockImplementation(() => { throw new Error("not found"); });
			expect(OpenCodeAcpAdapter.getVersion()).toBe(null);
		});

		it("accepts custom binary parameter", () => {
			mockExec.mockReturnValue("custom 1.0\n");
			expect(OpenCodeAcpAdapter.getVersion("custom-bin")).toBe("custom-bin: custom 1.0");
		});
	});

	describe("resolveBinary", () => {
		it("returns opencode when available", () => {
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("opencode")) return Buffer.from("/usr/bin/opencode");
				throw new Error("not found");
			});
			expect(OpenCodeAcpAdapter.resolveBinary()).toBe("opencode");
		});

		it("returns ocxo when opencode not available", () => {
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("ocxo")) return Buffer.from("/usr/bin/ocxo");
				throw new Error("not found");
			});
			expect(OpenCodeAcpAdapter.resolveBinary()).toBe("ocxo");
		});

		it("returns null when neither available", () => {
			mockExec.mockImplementation(() => { throw new Error("not found"); });
			expect(OpenCodeAcpAdapter.resolveBinary()).toBe(null);
		});
	});

	describe("constructor", () => {
		it("provides default config", () => {
			mockExec.mockImplementation(() => { throw new Error("not found"); });
			const adapter = new OpenCodeAcpAdapter({});
			expect(adapter.name).toBe("opencode");
			expect(adapter["config"].args).toEqual(["acp"]);
		});

		it("uses explicit config command over auto-resolve", () => {
			const adapter = new OpenCodeAcpAdapter({
				config: { command: "my-ocxo" },
			});
			expect(adapter["config"].command).toBe("my-ocxo");
		});

		it("uses resolved binary when no config provided", () => {
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("ocxo")) return Buffer.from("/usr/bin/ocxo");
				throw new Error("not found");
			});
			const adapter = new OpenCodeAcpAdapter({});
			expect(adapter["config"].command).toBe("ocxo");
		});
	});
});

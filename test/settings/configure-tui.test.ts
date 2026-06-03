import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";

// Mock node:os to override homedir but keep tmpdir
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const fakeHome = pathJoin(actual.tmpdir(), `acp-configure-test-${process.pid}`);
	return {
		...actual,
		homedir: () => fakeHome,
	};
});

import { configureToolSettings } from "../../src/settings/configure-tui.js";

describe("configureToolSettings", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(pathJoin(tmpdir(), "acp-configure-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		try {
			const { homedir } = require("node:os");
			const { join } = require("node:path");
			rmSync(join(homedir(), ".pi", "acp-agents"), { recursive: true, force: true });
		} catch { /* ok */ }
	});

	it("returns null when hasUI is false", async () => {
		const ctx = {
			hasUI: false,
			ui: {
				confirm: vi.fn(),
				input: vi.fn(),
				notify: vi.fn(),
				select: vi.fn(),
			},
		};
		const result = await configureToolSettings(ctx, tmpDir);
		expect(result).toBeNull();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Interactive UI required for ACP settings",
			"warning",
		);
	});

	it("returns null when user immediately selects Done", async () => {
		const ctx = {
			hasUI: true,
			ui: {
				confirm: vi.fn(),
				input: vi.fn(),
				notify: vi.fn(),
				select: vi.fn(async (_prompt: string, _items: string[]) => {
					return "Done";
				}),
			},
		};
		const result = await configureToolSettings(ctx, tmpDir);
		expect(result).toBeNull();
		expect(ctx.ui.notify).toHaveBeenCalledWith("No changes made.", "info");
	});

	it("returns null when user cancels (undefined from select)", async () => {
		const ctx = {
			hasUI: true,
			ui: {
				confirm: vi.fn(),
				input: vi.fn(),
				notify: vi.fn(),
				select: vi.fn(async () => undefined),
			},
		};
		const result = await configureToolSettings(ctx, tmpDir);
		expect(result).toBeNull();
		expect(ctx.ui.notify).toHaveBeenCalledWith("No changes made.", "info");
	});

	it("configures a group and saves", async () => {
		let selectCount = 0;
		const ctx = {
			hasUI: true,
			ui: {
				confirm: vi.fn(),
				input: vi.fn(),
				notify: vi.fn(),
				select: vi.fn(async (_prompt: string, items: string[]) => {
					selectCount++;
					if (selectCount === 1) {
						return items.find((i: string) => i.startsWith("Core"));
					}
					if (selectCount === 2) {
						return "Disable";
					}
					if (selectCount === 3) {
						return "✓ enabled (keep)";
					}
					return "Done";
				}),
			},
		};
		const result = await configureToolSettings(ctx, tmpDir);
		expect(result).not.toBeNull();
		expect(result!.tools.acp_prompt.enabled).toBe(false);
		expect(result!.tools.acp_status.enabled).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("saved"),
			"info",
		);
	});

	it("enables a disabled tool", async () => {
		const { join } = require("node:path");
		const settingsPath = join(tmpDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({
			tools: { acp_prompt: { enabled: false } },
		}));

		let selectCount = 0;
		const ctx = {
			hasUI: true,
			ui: {
				confirm: vi.fn(),
				input: vi.fn(),
				notify: vi.fn(),
				select: vi.fn(async (_prompt: string, items: string[]) => {
					selectCount++;
					if (selectCount === 1) {
						return items.find((i: string) => i.startsWith("Core"));
					}
					if (selectCount === 2) {
						return "Enable";
					}
					if (selectCount === 3) {
						return "✓ enabled (keep)";
					}
					return "Done";
				}),
			},
		};
		const result = await configureToolSettings(ctx, tmpDir);
		expect(result).not.toBeNull();
		expect(result!.tools.acp_prompt.enabled).toBe(true);
	});
});

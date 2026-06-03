/**
 * Additional branch coverage for adapters/base.ts
 * Targets: initialize/prompt/newSession/loadSession/setModel/setMode without spawn,
 * cancel when no client, dispose with client, connected getter
 */
import { describe, it, expect, vi } from "vitest";
import { AcpAgentAdapter } from "../../src/adapters/base.js";
import type { AcpAgentConfig } from "../../src/config/types.js";

// Create a concrete subclass for testing
class TestAdapter extends AcpAgentAdapter {
	get name(): string {
		return "test";
	}
	protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
		return { ...config };
	}
}

describe("AcpAgentAdapter — branch coverage", () => {
	function makeAdapter(): TestAdapter {
		return new TestAdapter({
			config: { command: "test", args: [] },
		});
	}

	describe("initialize — not spawned", () => {
		it("throws when not spawned", async () => {
			const adapter = makeAdapter();
			await expect(adapter.initialize()).rejects.toThrow("Not spawned");
		});
	});

	describe("newSession — not spawned", () => {
		it("throws when not spawned", async () => {
			const adapter = makeAdapter();
			await expect(adapter.newSession()).rejects.toThrow("Not spawned");
		});
	});

	describe("prompt — not spawned", () => {
		it("throws when not spawned", async () => {
			const adapter = makeAdapter();
			await expect(adapter.prompt("hello")).rejects.toThrow("Not spawned");
		});
	});

	describe("loadSession — not spawned", () => {
		it("throws when not spawned", async () => {
			const adapter = makeAdapter();
			await expect(adapter.loadSession("abc")).rejects.toThrow("Not spawned");
		});
	});

	describe("setModel — not spawned", () => {
		it("throws when not spawned", async () => {
			const adapter = makeAdapter();
			await expect(adapter.setModel("gpt-4")).rejects.toThrow("Not spawned");
		});
	});

	describe("setMode — not spawned", () => {
		it("throws when not spawned", async () => {
			const adapter = makeAdapter();
			await expect(adapter.setMode("auto")).rejects.toThrow("Not spawned");
		});
	});

	describe("cancel — no client", () => {
		it("does not throw when no client", async () => {
			const adapter = makeAdapter();
			await adapter.cancel();
			// Graceful no-op
		});
	});

	describe("getSessionId — no client", () => {
		it("returns null when no client", () => {
			const adapter = makeAdapter();
			expect(adapter.getSessionId()).toBeNull();
		});
	});

	describe("connected getter", () => {
		it("returns false when no client", () => {
			const adapter = makeAdapter();
			expect(adapter.connected).toBe(false);
		});
	});

	describe("dispose", () => {
		it("sets client to null when called", () => {
			const adapter = makeAdapter();
			adapter.dispose();
			expect(adapter.connected).toBe(false);
		});
	});

	describe("with cwd option", () => {
		it("uses provided cwd", () => {
			const adapter = new TestAdapter({
				config: { command: "test", args: [] },
				cwd: "/custom/path",
			});
			expect(adapter["cwd"]).toBe("/custom/path");
		});
	});
});

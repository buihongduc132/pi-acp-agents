import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { AcpAdapterOptions } from "../../src/adapters/base.js";
import { AcpAgentAdapter } from "../../src/adapters/base.js";

// Mock child_process
mock.module("node:child_process", () => ({
	spawn: mock(() => {
		const { Writable, Readable } = require("node:stream");
		const { EventEmitter } = require("node:events");
		return {
			stdin: new Writable({ write(_c: any, _e: any, cb: any) { cb(); } }),
			stdout: new Readable({ read() {} }),
			stderr: new EventEmitter(),
			killed: false,
			kill: mock(),
			on: mock(),
		};
	}),
}));

mock.module("../../src/core/circuit-breaker.js", () => ({
	killWithEscalation: mock(),
}));

mock.module("../../src/core/protocol-validator.js", () => ({
	classifyConnectionError: mock((err) => err),
	validateInitializeResponse: mock(),
	validateNewSessionResponse: mock(),
	validatePromptResponse: mock(),
	AcpProtocolError: class extends Error {
		constructor(public details: any) { super(details.message); this.name = "AcpProtocolError"; }
	},
}));

mock.module("../../src/logger.js", () => ({
	createNoopLogger: mock(() => ({ info: mock(), error: mock(), debug: mock() })),
	createFileLogger: mock(() => ({ info: mock(), error: mock(), debug: mock() })),
}));

/** Concrete subclass for testing */
class TestAdapter extends AcpAgentAdapter {
	get name(): string { return "test"; }
}

function makeOpts(overrides: Partial<AcpAdapterOptions> = {}): AcpAdapterOptions {
	return {
		config: { command: "test-cmd", args: [] },
		clientInfo: { name: "test-client", version: "1.0" },
		...overrides,
	};
}

describe("AcpAgentAdapter (base)", () => {
	beforeEach(() => {
	});

	describe("constructor", () => {
		it("uses provided config", () => {
			const adapter = new TestAdapter(makeOpts());
			expect(adapter["config"].command).toBe("test-cmd");
		});

		it("defaults clientInfo when not provided", () => {
			const adapter = new TestAdapter({ config: { command: "c", args: [] } });
			expect(adapter["clientInfo"].name).toBe("pi-acp-agents");
		});

		it("defaults cwd when not provided", () => {
			const adapter = new TestAdapter(makeOpts());
			expect(adapter["cwd"]).toBe(process.cwd());
		});

		it("uses provided cwd", () => {
			const adapter = new TestAdapter(makeOpts({ cwd: "/custom" }));
			expect(adapter["cwd"]).toBe("/custom");
		});

		it("stores onActivity callback", () => {
			const cb = mock();
			const adapter = new TestAdapter(makeOpts({ onActivity: cb }));
			expect(adapter["onActivity"]).toBe(cb);
		});
	});

	describe("methods when not spawned", () => {
		it("initialize throws", async () => {
			const adapter = new TestAdapter(makeOpts());
			await expect(adapter.initialize()).rejects.toThrow("Not spawned");
		});

		it("newSession throws", async () => {
			const adapter = new TestAdapter(makeOpts());
			await expect(adapter.newSession()).rejects.toThrow("Not spawned");
		});

		it("prompt throws", async () => {
			const adapter = new TestAdapter(makeOpts());
			await expect(adapter.prompt("hi")).rejects.toThrow("Not spawned");
		});

		it("loadSession throws", async () => {
			const adapter = new TestAdapter(makeOpts());
			await expect(adapter.loadSession("sid")).rejects.toThrow("Not spawned");
		});

		it("setModel throws", async () => {
			const adapter = new TestAdapter(makeOpts());
			await expect(adapter.setModel("gpt-4")).rejects.toThrow("Not spawned");
		});

		it("setMode throws", async () => {
			const adapter = new TestAdapter(makeOpts());
			await expect(adapter.setMode("auto")).rejects.toThrow("Not spawned");
		});

		it("getSessionId returns null", () => {
			const adapter = new TestAdapter(makeOpts());
			expect(adapter.getSessionId()).toBeNull();
		});

		it("connected returns false", () => {
			const adapter = new TestAdapter(makeOpts());
			expect(adapter.connected).toBe(false);
		});

		it("cancel does not throw", async () => {
			const adapter = new TestAdapter(makeOpts());
			await expect(adapter.cancel()).resolves.toBeUndefined();
		});
	});

	describe("dispose", () => {
		it("clears client reference", async () => {
			const adapter = new TestAdapter(makeOpts());
			await adapter.spawn();
			expect(adapter.connected).toBe(true);
			adapter.dispose();
			expect(adapter.connected).toBe(false);
			expect(adapter.getSessionId()).toBeNull();
		});

		it("is safe to call when no client", () => {
			const adapter = new TestAdapter(makeOpts());
			adapter.dispose();
			expect(adapter.connected).toBe(false);
		});
	});
});

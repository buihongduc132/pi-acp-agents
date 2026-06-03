/**
 * Branch coverage for adapters/base.ts — positive paths (with client)
 * Tests both branches of each guard: no-client (throws) and with-client (delegates)
 */
import { describe, it, expect, mock } from "bun:test";
import { AcpAgentAdapter } from "../../src/adapters/base.js";
import type { AcpAgentConfig } from "../../src/config/types.js";

// Mock AcpClient
mock.module("../../src/core/client.js", () => {
	return {
		AcpClient: class MockAcpClient {
			connect = mock().mockResolvedValue(undefined);
			initialize = mock().mockResolvedValue({ protocolVersion: "0.1" });
			newSession = mock().mockResolvedValue("session-123");
			quickPrompt = mock().mockResolvedValue({ text: "hi", stopReason: "end_turn", sessionId: "session-123" });
			cancel = mock().mockResolvedValue(undefined);
			loadSession = mock().mockResolvedValue("session-456");
			setModel = mock().mockResolvedValue(undefined);
			setMode = mock().mockResolvedValue(undefined);
			dispose = mock();
			sessionId = "session-123";
			agentInfo = { protocolVersion: "0.1" };
			connected = true;
		},
	};
});

class TestAdapter extends AcpAgentAdapter {
	get name(): string { return "test"; }
	protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
		return { ...config };
	}
}

describe("AcpAgentAdapter — positive path branches", () => {
	async function makeSpawnedAdapter() {
		const adapter = new TestAdapter({
			config: { command: "test-cmd", args: [] },
		});
		await adapter.spawn();
		return adapter;
	}

	it("initialize delegates to client after spawn", async () => {
		const adapter = await makeSpawnedAdapter();
		await adapter.initialize();
		expect(adapter["client"]).toBeTruthy();
	});

	it("newSession delegates to client after spawn", async () => {
		const adapter = await makeSpawnedAdapter();
		const sessionId = await adapter.newSession();
		expect(sessionId).toBe("session-123");
	});

	it("prompt delegates to client after spawn", async () => {
		const adapter = await makeSpawnedAdapter();
		const result = await adapter.prompt("hello");
		expect(result.text).toBe("hi");
		expect(result.stopReason).toBe("end_turn");
	});

	it("loadSession delegates to client after spawn", async () => {
		const adapter = await makeSpawnedAdapter();
		const sessionId = await adapter.loadSession("session-456");
		expect(sessionId).toBe("session-456");
	});

	it("setModel delegates to client after spawn", async () => {
		const adapter = await makeSpawnedAdapter();
		await adapter.setModel("gpt-4");
		expect(adapter["client"]!.setModel).toHaveBeenCalledWith("gpt-4");
	});

	it("setMode delegates to client after spawn", async () => {
		const adapter = await makeSpawnedAdapter();
		await adapter.setMode("auto");
		expect(adapter["client"]!.setMode).toHaveBeenCalledWith("auto");
	});

	it("cancel delegates to client", async () => {
		const adapter = await makeSpawnedAdapter();
		await adapter.cancel();
		expect(adapter["client"]!.cancel).toHaveBeenCalled();
	});

	it("getSessionId returns sessionId from client", async () => {
		const adapter = await makeSpawnedAdapter();
		expect(adapter.getSessionId()).toBe("session-123");
	});

	it("connected returns true when client connected", async () => {
		const adapter = await makeSpawnedAdapter();
		expect(adapter.connected).toBe(true);
	});

	it("dispose clears client", async () => {
		const adapter = await makeSpawnedAdapter();
		adapter.dispose();
		expect(adapter.connected).toBe(false);
		expect(adapter.getSessionId()).toBeNull();
	});
});

/**
 * Live smoke test: verify ocxo (opencode) ACP connection
 *
 * This test spawns the real `ocxo acp` process and performs the ACP handshake.
 * Skipped if `ocxo` is not on PATH.
 */
import { describe, it, expect } from "vitest";
import { OpenCodeAcpAdapter } from "../src/adapters/opencode.js";

describe.skipIf(!OpenCodeAcpAdapter.isAvailable())("OpenCode ACP live smoke test", () => {
	const adapter = new OpenCodeAcpAdapter({ cwd: "/tmp" });

	it("spawns and initializes ACP connection", async () => {
		try {
			await adapter.spawn();
			expect(adapter.connected).toBe(true);

			await adapter.initialize();
			// After init, adapter should have a session-capable client
			expect(adapter.connected).toBe(true);
		} finally {
			adapter.dispose();
		}
	}, 30_000);

	it("creates a session", async () => {
		const logsDir = "/tmp/acp-test-logs";
		const { mkdirSync } = await import("node:fs");
		mkdirSync(logsDir, { recursive: true });

		const { AcpClient } = await import("../src/core/client.js");
		const { createFileLogger } = await import("../src/logger.js");
		const logger = createFileLogger(logsDir);

		const client = new AcpClient({
			agentName: "opencode",
			config: { command: "ocxo", args: ["acp"] },
			cwd: "/tmp",
			logger,
			logsDir,
		});

		try {
			await client.connect();
			const info = await client.initialize();
			expect(info).toBeTruthy();

			const sid = await client.newSession();
			expect(sid).toBeTruthy();
			expect(client.sessionId).toBe(sid);
		} finally {
			await client.dispose();
		}
	}, 30_000);

	// NOTE: Prompt test is intentionally a longer integration test.
	// Run with: npx vitest run test/opencode-live.test.ts --testTimeout=120000
	it.todo("sends a prompt and collects response (run manually with --testTimeout=120000)", async () => {
		const logsDir = "/tmp/acp-test-logs";
		const { mkdirSync } = await import("node:fs");
		mkdirSync(logsDir, { recursive: true });

		const { AcpClient } = await import("../src/core/client.js");
		const { createFileLogger } = await import("../src/logger.js");
		const logger = createFileLogger(logsDir);

		const client = new AcpClient({
			agentName: "opencode",
			config: { command: "ocxo", args: ["acp"] },
			cwd: "/home/bhd/Documents/Projects/bhd/pi-acp-agents",
			logger,
			logsDir,
		});

		try {
			await client.connect();
			await client.initialize();
			await client.newSession();

			const result = await client.prompt("Say exactly the word PONG and nothing else.");
			console.log("prompt result:", JSON.stringify(result));
			expect(result.stopReason).toBeDefined();
			if (result.text) {
				console.log("collected text:", result.text.slice(0, 200));
			}
		} finally {
			await client.dispose();
		}
	});
});

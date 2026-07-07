/**
 * Concurrency probe — proves that concurrent same-agent delegates are
 * serialized (maxInFlight === 1) on the pooled adapter.
 *
 * Without serialization: concurrent delegates share one ACP session and
 * prompts interleave → output cross-contamination (caller A receives
 * caller B's response). This test catches that regression.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import type { AcpConfig } from "../../src/config/types.js";
import { createAdapter } from "../../src/adapter-factory.js";

vi.mock("../../src/adapter-factory.js");

const mockConfig: AcpConfig = {
	agent_servers: {
		pi: { command: "pi-acp", args: [] },
	},
	defaultAgent: "pi",
};

describe("P4 concurrency — same-agent delegates are serialized", () => {
	it("3 concurrent delegates to same agent → maxInFlight === 1 (no cross-contamination)", async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		const mockAdapter = {
			spawn: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue(undefined),
			newSession: vi.fn().mockResolvedValue("sess-1"),
			cancel: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
			connected: true,
			prompt: vi.fn().mockImplementation(async (message: string) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 50));
				inFlight--;
				return { text: `response-to-${message}`, stopReason: "end_turn" as const, sessionId: "sess-1" };
			}),
		};

		(createAdapter as any).mockReturnValue(mockAdapter);
		const coordinator = new AgentCoordinator(mockConfig, "/tmp");

		// Fire 3 concurrent delegates to the SAME agent
		const results = await Promise.all([
			coordinator.delegate("pi", "msg-A"),
			coordinator.delegate("pi", "msg-B"),
			coordinator.delegate("pi", "msg-C"),
		]);

		// CRITICAL: only 1 prompt in-flight at a time (serialized)
		expect(maxInFlight).toBe(1);

		// Each caller got their OWN response (no cross-contamination)
		expect(results[0].text).toBe("response-to-msg-A");
		expect(results[1].text).toBe("response-to-msg-B");
		expect(results[2].text).toBe("response-to-msg-C");

		// Only 1 adapter was created (pooled)
		expect(createAdapter).toHaveBeenCalledTimes(1);

		coordinator.dispose();
	});
});

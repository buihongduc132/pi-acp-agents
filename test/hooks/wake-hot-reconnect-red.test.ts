/**
 * RED phase — proves the hot reconnect loop bug EXISTS in current code.
 *
 * These tests assert the DESIRED (fixed) behavior. Against the UNFIXED code
 * they FAIL with assertion errors, proving the bug. Once the GREEN fix is
 * applied, these tests PASS and are kept as permanent regression tests.
 *
 * This file is committed SEPARATELY before the fix (per repo TDD convention)
 * to provide git evidence of the RED phase.
 *
 * Bug summary: when a socket connects-then-immediately-closes (flapping peer),
 * reconnectAfterClose enters a zero-backoff hot loop:
 *   - start() only delays on FAILED connects, not successful ones
 *   - no lifetime cap on reconnect attempts
 *   - no rate-limit on the "scheduling reconnect" log line
 * This produced a 152GB main.log at ~170KB/s in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketLike } from "../../src/hooks/wake-subscriber.js";

class MockSocket extends EventEmitter implements SocketLike {
	public destroyed = false;
	constructor(public readonly id: number) {
		super();
	}
	write(): unknown {
		return true;
	}
	end(): unknown {
		return undefined;
	}
	destroy(): unknown {
		this.destroyed = true;
		return undefined;
	}
}

function createMockPi() {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		isIdle: vi.fn().mockReturnValue(true),
		log: vi.fn(),
	};
}

describe("RED — wake-subscriber hot reconnect loop (proves the bug on unfixed code)", () => {
	let tmpDir: string;
	let sockPath: string;

	beforeEach(() => {
		vi.useFakeTimers();
		tmpDir = mkdtempSync(join(tmpdir(), "acp-wake-red-"));
		sockPath = join(tmpDir, "events.sock");
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("backoff: connect→close flap must NOT spin at zero delay", async () => {
		const pi = createMockPi();
		let connectCalls = 0;

		const wake = new WakeSubscriber({
			path: sockPath,
			pi,
			retryDelayMs: 1,
			connector: async () => {
				connectCalls++;
				return new MockSocket(connectCalls);
			},
		});

		await wake.start();
		expect(connectCalls).toBe(1);

		// Fire reconnects and advance only 100ms. With a backoff floor (>=1000ms),
		// NO reconnect should fire within 100ms.
		for (let i = 0; i < 10; i++) {
			wake["reconnectAfterClose"]();
		}
		await vi.advanceTimersByTimeAsync(100);

		// DESIRED (fixed): connectCalls stays 1 (no reconnect in 100ms).
		// UNFIXED: reconnectAfterClose has no backoff on successful connect,
		// so all 10 fire instantly → connectCalls = 11. Assertion FAILS → RED.
		expect(connectCalls).toBe(1);
	});

	it("cap: subscriber must go dormant after maxReconnectAttempts", async () => {
		const pi = createMockPi();
		let connectCalls = 0;

		const wake = new WakeSubscriber({
			path: sockPath,
			pi,
			retryDelayMs: 1,
			maxReconnectAttempts: 3,
			connector: async () => {
				connectCalls++;
				return new MockSocket(connectCalls);
			},
		});

		await wake.start();

		// Drive reconnect cycles past the cap.
		for (let i = 0; i < 10; i++) {
			const p = wake["reconnectAfterClose"]();
			await vi.advanceTimersByTimeAsync(1100);
			await p;
		}

		// DESIRED (fixed): connectCalls <= start(1) + cap(3) = 4.
		// UNFIXED: no cap → reconnects all 10 → connectCalls = 11. FAILS → RED.
		expect(connectCalls).toBeLessThanOrEqual(4);
	});
});

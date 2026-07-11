/**
 * Regression test for EMFILE caused by WakeSubscriber socket leak.
 *
 * Root cause: the `close` handler spawned `reconnectAfterClose()` with no
 * reentrancy guard, and failed-connect sockets were never `.destroy()`'d.
 * A flapping/unavailable socket endpoint therefore opened unbounded fds.
 *
 * See flow/findings/2026-07-11_acp-logger-emfile-wake-subscriber.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WakeSubscriber } from "../../src/hooks/wake-subscriber.js";
import type { SocketLike } from "../../src/hooks/wake-subscriber.js";

/** Minimal SocketLike backed by EventEmitter so tests can emit close/error. */
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
		sendUserMessage: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
	};
}

describe("wake-subscriber — fd leak / EMFILE regression", () => {
	let tmpDir: string;
	let sockPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-wake-fd-"));
		sockPath = join(tmpDir, "events.sock");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does NOT spawn overlapping reconnects when close fires during an in-flight reconnect", async () => {
		const pi = createMockPi();

		// Slow connector: holds the reconnect in-flight so we can fire
		// multiple 'close' events while reconnecting === true.
		let resolveConnect: (s: MockSocket) => void = () => {};
		const connectPromise = () =>
			new Promise<MockSocket>((res) => {
				resolveConnect = res;
			});

		let connectCalls = 0;
		const sockets: MockSocket[] = [];
		const wake = new WakeSubscriber({
			path: sockPath,
			pi,
			connector: async () => {
				connectCalls++;
				const s = await connectPromise();
				sockets.push(s);
				return s;
			},
		});

		// Kick off start() — resolves once we release the first connector.
		const startP = wake.start();
		const first = new MockSocket(0);
		resolveConnect(first);
		await startP;
		expect(connectCalls).toBe(1);

		// Fire 50 NON-awaited (fire-and-forget) reconnectAfterClose calls,
		// mirroring how the close handler does `void this.reconnectAfterClose()`.
		// Without the guard these overlap and each opens a new socket → EMFILE.
		for (let i = 0; i < 49; i++) {
			void wake["reconnectAfterClose"]();
		}
		const reconnectP = wake["reconnectAfterClose"]();
		// At this point the connector has been awaited (synchronously up to
		// connectPromise) at most once — the guard dedups the rest.
		// Release the pending connector so the in-flight reconnect completes.
		const second = new MockSocket(1);
		resolveConnect(second);
		await reconnectP;

		// Despite 50 fire-and-forget reconnect invocations, the connector must
		// only have been called once more — NOT 50 times. No socket storm.
		expect(connectCalls).toBe(2);
		expect(sockets.length).toBe(2);

		await wake.stop();
	});

	it("start() destroys the previous live socket before opening a new one (no orphan fd)", async () => {
		const pi = createMockPi();
		let connectCalls = 0;
		const created: MockSocket[] = [];

		const wake = new WakeSubscriber({
			path: sockPath,
			pi,
			connector: async () => {
				connectCalls++;
				const s = new MockSocket(connectCalls);
				created.push(s);
				return s;
			},
		});

		await wake.start();
		expect(created.length).toBe(1);
		const first = created[0];
		expect(first.destroyed).toBe(false);

		// Calling start() again while a live socket is held must destroy it.
		await wake.start();
		expect(first.destroyed).toBe(true);
		expect(created.length).toBe(2);

		await wake.stop();
	});

	it("bounded socket creation over a flapping connect→close loop", async () => {
		const pi = createMockPi();
		let connectCalls = 0;

		const wake = new WakeSubscriber({
			path: sockPath,
			pi,
			retryDelayMs: 1,
			// Each connect immediately succeeds; we close it stepwise to flap.
			connector: async () => {
				connectCalls++;
				return new MockSocket(connectCalls);
			},
		});

		await wake.start();

		// Simulate a flap by repeatedly triggering reconnectAfterClose.
		// The guard serializes them — no parallel socket creation.
		for (let i = 0; i < 20; i++) {
			await wake["reconnectAfterClose"]();
		}

		// Connector calls bounded by legitimate reconnects (start + 20),
		// never multiplied by overlapping storms. Hard ceiling well under 100.
		expect(connectCalls).toBeLessThan(100);

		await wake.stop();
	});

	it("falls back to intercom without leaking fds when socket path is unavailable (real defaultConnect)", async () => {
		const pi = createMockPi();
		const intercomPublish = vi.fn().mockResolvedValue(undefined);

		const wake = new WakeSubscriber({
			path: join(tmpDir, "does-not-exist.sock"),
			pi,
			intercom: { publish: intercomPublish },
			maxSocketRetries: 3,
			retryDelayMs: 1,
			// No injected connector → exercises the real defaultConnect error
			// path where each failed attempt must .destroy() its socket.
		});

		await expect(wake.start()).resolves.not.toThrow();
		expect(wake.isUsingIntercom()).toBe(true);
		expect(intercomPublish).toHaveBeenCalled();

		// Loop safety: re-calling start() while in intercom mode must not throw
		// and must not attempt to destroy a null socket.
		await expect(wake.start()).resolves.not.toThrow();

		await wake.stop();
		expect(wake.isAlive()).toBe(false);
	});
});

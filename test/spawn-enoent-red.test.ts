/**
 * RED tests — proves that AcpClient.connect() crashes the host process when
 * the agent binary does not exist (ENOENT), instead of rejecting cleanly.
 *
 * Bug report:
 *   pi exiting due to uncaughtException:
 *   Error: spawn codex-acp ENOENT
 *       at ChildProcess._handle.onexit (node:internal/child_process:285:19)
 *       at onErrorNT (node:internal/child_process:483:16)
 *
 * Root cause:
 *   Node's child_process.spawn() does NOT throw synchronously when the binary
 *   is missing. It returns a ChildProcess and emits the ENOENT error
 *   asynchronously via the 'error' event. src/core/client.ts AcpClient.connect()
 *   wraps spawn() in try/catch (useless for async errors) and never attaches
 *   proc.on('error'). With no listener, Node throws on the next tick ->
 *   uncaughtException -> pi crashes.
 *
 * These tests intentionally use REAL spawn (no mock) to reproduce the actual
 * Node behaviour. They must FAIL before the fix and PASS after.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AcpClient } from "../src/core/client.js";
import type { AcpAgentConfig } from "../src/config/types.js";

// A binary name guaranteed to not exist on any PATH.
const GHOST_BINARY = "pi-acp-ghost-binary-DOES-NOT-EXIST-9f3a7c1e";

// ---------------------------------------------------------------------------
// GAP-3 mock: spawnSync MUST be mocked so the AcpxAdapter guard test does
// NOT depend on whether `acpx` happens to be installed on the host. The
// previous version of the test passed config.command=GHOST_BINARY, but
// AcpxAdapter._runAcpx ignores config.command and always shells out to the
// hardcoded ACX_BINARY = "acpx" — so the test passed by accident (whichever
// of acpx/GHOST_BINARY was missing on the host) and did NOT lock the
// invariant its docstring claims.
//
// vi.hoisted gives the mock factory access to shared mutable state (captured
// calls + queued result), and vi.mock("node:child_process") swaps the real
// spawnSync for our mock BEFORE AcpxAdapter is imported.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GAP-3 mock: spawnSync MUST be mocked so the AcpxAdapter guard test does
// NOT depend on whether `acpx` happens to be installed on the host. The
// previous version of the test passed config.command=GHOST_BINARY, but
// AcpxAdapter._runAcpx ignores config.command and always shells out to the
// hardcoded ACX_BINARY = "acpx" — so the test passed by accident (whichever
// of acpx/GHOST_BINARY was missing on the host) and did NOT lock the
// invariant its docstring claims.
//
// IMPORTANT — why vi.doMock (not vi.mock): vi.mock is hoisted above ALL
// imports and replaces `node:child_process` for the WHOLE file, which would
// also replace `spawn` — breaking the first 3 AcpClient tests that
// INTENTIONALLY exercise the REAL Node async spawn() ENOENT behaviour.
// We therefore keep the real module for AcpClient (imported at top level)
// and apply vi.doMock ONLY inside the guard test, immediately before the
// dynamic `await import("acpx.js")`. Because acpx.js imports ONLY
// `spawnSync` (never `spawn`) and is not yet cached at that point, the
// doMock swap is clean and isolated.
// ---------------------------------------------------------------------------
const { spawnSyncMock, resetSpawnSyncMock, queueSpawnSyncResult } = vi.hoisted(() => {
	const calls: Array<{ binary: string; args: string[] }> = [];
	let nextResult:
		| { status: number; stdout: string; stderr: string; error?: Error }
		| null = null;
	const spawnSyncMock = vi.fn((binary: string, args: string[]) => {
		calls.push({ binary, args: [...args] });
		return (
			nextResult ?? {
				status: 127,
				stdout: "",
				stderr: "",
				error: Object.assign(new Error(`spawn ${binary} ENOENT`), {
					code: "ENOENT",
				}),
			}
		);
	});
	function resetSpawnSyncMock() {
		calls.length = 0;
		nextResult = null;
		spawnSyncMock.mockClear();
	}
	function queueSpawnSyncResult(
		result: { status: number; stdout: string; stderr: string; error?: Error },
	) {
		nextResult = result;
	}
	return { spawnSyncMock, resetSpawnSyncMock, queueSpawnSyncResult };
});

// NOTE: no top-level vi.mock here — see the vi.doMock comment above. We
// scope the child_process mock to the AcpxAdapter guard test only so the
// AcpClient tests keep using the REAL async spawn().

function makeClient(command = GHOST_BINARY): AcpClient {
	const config: AcpAgentConfig = {
		command,
		args: [],
	} as AcpAgentConfig;
	return new AcpClient({
		agentName: "ghost",
		config,
		cwd: process.cwd(),
	});
}

/**
 * Helper: install a temporary uncaughtException capture listener so a
 * pre-fix crash surfaces as a captured error instead of killing the test
 * runner. Returns [capture, remove].
 */
function captureUncaught(): [
	capture: () => Error | null,
	remove: () => void,
] {
	let captured: Error | null = null;
	const handler = (err: Error) => {
		captured = err;
	};
	// 'uncaughtException' is the last line of defence. We use it so a pre-fix
	// bug does not tear down vitest. We also watch 'unhandledRejection'.
	process.once("uncaughtException", handler);
	const rejectionHandler = (err: unknown) => {
		if (err instanceof Error) captured = err;
	};
	process.once("unhandledRejection", rejectionHandler);
	return [
		() => captured,
		() => {
			process.removeListener("uncaughtException", handler);
			process.removeListener("unhandledRejection", rejectionHandler);
		},
	];
}

describe("RED: spawn ENOENT must not crash pi", () => {
	it("connect() rejects (does not crash) when binary is missing", async () => {
		const client = makeClient();
		const [capture, remove] = captureUncaught();

		let rejected = false;
		let rejectErr: unknown = null;
		try {
			await client.connect();
		} catch (err) {
			rejected = true;
			rejectErr = err;
		}

		// Give Node a few event-loop turns so any deferred 'error' event fires.
		await new Promise((r) => setTimeout(r, 50));
		remove();

		const crashed = capture();
		expect(
			crashed,
			`BUG: spawn ENOENT leaked as uncaughtException: ${crashed?.message ?? ""}`,
		).toBeNull();

		// Must reject, not silently succeed.
		expect(rejected, "connect() must reject when binary is missing").toBe(true);
		expect(rejectErr).toBeInstanceOf(Error);
		expect(String((rejectErr as Error)?.message ?? "")).toMatch(/ENOENT|spawn|could not be spawned/i);
	});

	it("connect() surfaces agent stderr in the error when available", async () => {
		const client = makeClient();
		const [capture, remove] = captureUncaught();
		let rejectErr: unknown = null;
		try {
			await client.connect();
		} catch (err) {
			rejectErr = err;
		}
		await new Promise((r) => setTimeout(r, 50));
		remove();

		expect(capture()).toBeNull();
		expect(rejectErr).toBeInstanceOf(Error);
		const msg = String((rejectErr as Error)?.message ?? "");
		// Fix must classify this as a spawn-phase failure (not a generic Error).
		expect(msg).toMatch(/spawn|could not be spawned|ENOENT/i);
		// Must reference the offending command so the user can debug.
		expect(msg).toContain(GHOST_BINARY);
	});

	it("dispose() after a failed connect does not throw and leaves no dangling process", async () => {
		const client = makeClient();
		const [capture, remove] = captureUncaught();
		try {
			await client.connect();
		} catch {
			// expected
		}
		await new Promise((r) => setTimeout(r, 30));
		remove();
		expect(capture()).toBeNull();

		// dispose must be safe even when proc was never fully attached.
		expect(() => {
			client.dispose();
		}).not.toThrow();
		expect(client.connected).toBe(false);
	});
});

/**
 * Guard test for the SIMILAR pattern in AcpxAdapter.
 * acpx.ts uses spawnSync (synchronous) and checks result.error, so ENOENT
 * is delivered synchronously (as result.error) and converted to a thrown
 * Error. This test locks that behaviour so a future refactor that switches
 * to async spawn() does not silently reintroduce the crash.
 *
 * GAP-3 FIX (option a — mock spawnSync): The previous version of this test
 * passed config.command = GHOST_BINARY and relied on the REAL spawnSync
 * failing. But AcpxAdapter._runAcpx() IGNORES config.command and always
 * shells out to the hardcoded ACX_BINARY = "acpx" (src/adapters/acpx.ts).
 * The old test therefore passed by accident — whichever of acpx/GHOST_BINARY
 * was missing on the host triggered ENOENT — and did NOT lock the invariant
 * its docstring claimed. We now mock spawnSync so the test is deterministic
 * regardless of whether `acpx` is installed, and we assert the mock was
 * actually called with the real binary name "acpx" (proving the spawnSync
 * code path was exercised, not bypassed).
 */
describe("RED/GUARD: AcpxAdapter spawnSync ENOENT stays synchronous", () => {
	beforeEach(() => {
		resetSpawnSyncMock();
	});

	it("throws a classified Error (does not emit uncaughtException) when spawnSync reports ENOENT", async () => {
		// Mock spawnSync to return the ENOENT shape AcpxAdapter._runAcpx
		// checks via result.error — deterministic, no host dependency.
		queueSpawnSyncResult({
			status: 127,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawn acpx ENOENT"), { code: "ENOENT" }),
		});

		// Scope the mock to THIS test only — acpx.js is not yet imported, so
		// its `import { spawnSync }` will resolve to our mock. AcpClient
		// (already loaded at top level) is unaffected and keeps real spawn.
		vi.doMock("node:child_process", () => ({
			spawnSync: spawnSyncMock,
		}));

		const { AcpxAdapter } = await import("../src/adapters/acpx.js");
		// config.command is intentionally the real "acpx" (matching what
		// _runAcpx actually uses) — no ghost binary anywhere.
		const adapter = new AcpxAdapter({
			agentName: "some-agent",
			config: { command: "acpx", args: [] } as AcpAgentConfig,
		});

		const [capture, remove] = captureUncaught();
		let threw = false;
		let err: unknown = null;
		try {
			await adapter.spawn();
		} catch (e) {
			threw = true;
			err = e;
		}
		await new Promise((r) => setTimeout(r, 30));
		remove();

		// INVARIANT 1: spawnSync MUST have been invoked — proves the code path
		// under test was actually exercised (the old test could not assert this).
		expect(
			spawnSyncMock,
			"AcpxAdapter.spawn must call spawnSync; this assertion locks the " +
				"sync code path so a future refactor to async spawn() is caught",
		).toHaveBeenCalled();

		// INVARIANT 2: it MUST have been invoked with the hardcoded "acpx"
		// binary (the value _runAcpx actually uses), proving the test is
		// exercising the real call site — not passing by accident of which
		// binary the host happens to be missing.
		expect(
			spawnSyncMock.mock.calls[0]?.[0],
			"spawnSync must be called with the hardcoded ACX_BINARY = 'acpx' " +
				"(AcpxAdapter ignores config.command); this is the exact call " +
				"site a refactor would need to preserve",
		).toBe("acpx");

		expect(capture(), "acpx spawnSync must never crash pi").toBeNull();
		expect(threw, "acpx spawn failure must throw, not crash").toBe(true);
		expect(err).toBeInstanceOf(Error);
		expect(String((err as Error)?.message ?? "")).toMatch(/spawn failed|ENOENT|not found|acpx/i);
	});
});

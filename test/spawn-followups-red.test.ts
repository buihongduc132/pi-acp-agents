/**
 * RED tests — follow-up gaps surfaced by the spawn-ENOENT fix review.
 *
 * These tests document bugs/gaps the original fix (src/core/client.ts
 * connect()) does NOT cover. They MUST fail (RED) against the current tree.
 * Each describe block cites the exact gap from the review and the invariant
 * the GREEN fix must enforce.
 *
 * Gaps covered:
 *   GAP-1 (HIGH)   Late spawn error after connect() resolves is silently
 *                  swallowed by initialize()/newSession()/prompt().
 *   GAP-2 (MED)    "Binary exists, exits non-zero immediately" is never
 *                  surfaced — it hangs to timeout, not rejected fast.
 *   GAP-4 (MED)    dispose() does not install a no-op guard; the persistent
 *                  proc.on('error') callback mutates dead-client state.
 *
 * Test-quality gaps (items 3 & 5 from the review) are documented in a final
 * describe block as `.skip` so they show up in the run as TODO markers,
 * because they require editing an existing test/comment rather than adding
 * new assertions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { platform } from "node:os";

// ---------------------------------------------------------------------------
// Mocks — same pattern as client-branches.test.ts / client-unit.test.ts
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
	mockSpawn: vi.fn() as unknown as ReturnType<typeof vi.fn>,
	/**
	 * The REAL child_process.spawn, captured so the GAP-2 test can delegate to
	 * it and exercise a real immediately-exiting binary (e.g. `false`). The
	 * file-level vi.mock below overrides spawn with mockSpawn for GAP-1/GAP-4
	 * (which inject a fake proc via mockReturnValue); GAP-2 re-points mockSpawn
	 * at realSpawn so the OS actually spawns the binary and fires a real
	 * 'exit' event. Without this, a bare `vi.mock(() => ({ spawn: mockSpawn }))`
	 * would shadow real spawn and GAP-2 could never observe an exit.
	 */
	realSpawn: null as null | ((...args: any[]) => any),
}));
const { mockSpawn } = hoisted;
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	hoisted.realSpawn = actual.spawn as unknown as (...args: any[]) => any;
	return { ...actual, spawn: hoisted.mockSpawn };
});

vi.mock("../src/core/circuit-breaker.js", () => ({
	killWithEscalation: vi.fn(),
}));

// Keep the REAL protocol-validator so classifyConnectionError produces the
// real AcpProtocolError shape — the GAP-1 invariant specifically checks for
// classified errors (phase: "spawn"), not raw Error passthrough.

vi.mock("../src/logger.js", () => ({
	createFileLogger: vi.fn(() => ({
		info: vi.fn(),
    warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	})),
	createNoopLogger: vi.fn(() => ({
		info: vi.fn(),
    warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	})),
}));

import { AcpClient } from "../src/core/client.js";
import { AcpProtocolError } from "../src/core/protocol-validator.js";
import type { AcpAgentConfig } from "../src/config/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProc() {
	const proc = new EventEmitter() as any;
	proc.stdin = new Writable({ write(_c: any, _e: any, cb: any) { cb(); } });
	proc.stdout = new Readable({ read() {} });
	proc.stderr = new EventEmitter();
	proc.killed = false;
	proc.kill = vi.fn(() => { proc.killed = true; });
	return proc;
}

function makeClient(opts: Record<string, any> = {}): AcpClient {
	const config: AcpAgentConfig = (opts.config ?? {
		command: "test-cmd",
		args: [],
	}) as AcpAgentConfig;
	return new AcpClient({
		agentName: opts.agentName ?? "test-agent",
		config,
		cwd: opts.cwd ?? "/tmp",
		...opts,
	});
}

beforeEach(() => {
	mockSpawn.mockReset();
	mockSpawn.mockReturnValue(createMockProc());
});

// ===========================================================================
// GAP-1 — initialize() / newSession() / prompt() must reject when a late
// spawn error has fired. The fix only guarded connect(); the same async
// 'error' event can fire DURING initialize()/newSession()/prompt() when the
// process dies abnormally (OOM-kill, EPIPE cascade, external kill) and the
// persistent proc.on('error') listener in connect() silently sets
// this.spawnError with nobody awaiting it.
// ===========================================================================

describe("RED GAP-1: late spawn error during initialize() must reject with classified error", () => {
	it("initialize() rejects when proc emits 'error' after connect() returned", async () => {
		const proc = createMockProc();
		mockSpawn.mockReturnValue(proc);
		const client = makeClient();

		await client.connect(); // succeeds — no error in flight

		// Simulate a late async spawn error (process died abnormally
		// post-connect, e.g. SIGKILL from OOM). The persistent proc.on('error')
		// listener (attached in connect()) sets this.spawnError.
		proc.emit("error", Object.assign(new Error("spawn EPERM"), { code: "EPERM" }));
		// Yield so the listener runs synchronously before our assertion.
		await Promise.resolve();

		let rejected = false;
		let err: unknown = null;
		try {
			await client.initialize();
		} catch (e) {
			rejected = true;
			err = e;
		}

		expect(
			rejected,
			"GAP-1: initialize() must reject when spawnError is set; " +
				"currently it calls this.conn.initialize() against a dead process and hangs/times out",
		).toBe(true);
		// Must be a CLASSIFIED error (phase: spawn), not a raw SDK rejection.
		expect(err).toBeInstanceOf(AcpProtocolError);
		expect((err as AcpProtocolError).message).toMatch(/spawn|EPERM|could not be spawned/i);
	});

	it("newSession() rejects when proc emits 'error' after connect() returned", async () => {
		const proc = createMockProc();
		mockSpawn.mockReturnValue(proc);
		const client = makeClient();
		await client.connect();

		proc.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
		await Promise.resolve();

		let rejected = false;
		try {
			await client.newSession();
		} catch {
			rejected = true;
		}
		expect(
			rejected,
			"GAP-1: newSession() must reject when spawnError is set",
		).toBe(true);
	});

	it("prompt() rejects when proc emits 'error' after connect()+newSession() succeeded", async () => {
		const proc = createMockProc();
		mockSpawn.mockReturnValue(proc);
		const client = makeClient();
		await client.connect();
		// Force a session id so prompt() reaches the conn.prompt path.
		(client as any)._sessionId = "sess-fake";
		(client as any).conn = {
			prompt: vi.fn(() => new Promise(() => {})), // never resolves — simulates hang
		} as any;

		proc.emit("error", Object.assign(new Error("spawn ECONNRESET"), { code: "ECONNRESET" }));
		await Promise.resolve();

		let rejected = false;
		try {
			await client.prompt("hi");
		} catch {
			rejected = true;
		}
		expect(
			rejected,
			"GAP-1: prompt() must reject when spawnError is set; " +
				"currently it awaits conn.prompt() forever (the conn is dead)",
		).toBe(true);
	});

	it("quickPrompt() rejects when spawnError fires mid-cycle instead of hanging", async () => {
		const proc = createMockProc();
		mockSpawn.mockReturnValue(proc);
		const client = makeClient();
		// conn is null — quickPrompt will call connect() first; force a late
		// error right after connect resolves.
		const originalConnect = client.connect.bind(client);
		(client as any).connect = async () => {
			await originalConnect();
			proc.emit("error", Object.assign(new Error("spawn ENOENT late"), { code: "ENOENT" }));
		};

		let rejected = false;
		try {
			await client.quickPrompt("hi");
		} catch {
			rejected = true;
		}
		expect(rejected, "GAP-1: quickPrompt must surface late spawn errors").toBe(true);
	});
});

// ===========================================================================
// GAP-2 — A binary that EXISTS but exits non-zero immediately must be
// detected and rejected fast. It is the most common real-world failure
// (wrong args, missing --acp flag, crash on startup). It does NOT trigger
// proc 'error' (only 'exit' fires), so the connect()-phase guard cannot
// catch it — initialize()/newSession()/prompt() currently hang until timeout.
//
// We use a REAL spawn so the 'exit' event actually fires.
// ===========================================================================

describe("RED GAP-2: binary exists but exits non-zero immediately must not hang", () => {
	// Use a guaranteed-to-exist, immediately-exiting binary.
	// `false` exits 1 with no output on every POSIX system.
	// On Windows we use cmd.exe /c exit 1 via shell:true.
	const immediateExitCmd = platform() === "win32" ? "cmd.exe" : "false";
	const immediateExitArgs = platform() === "win32" ? ["/c", "exit", "1"] : [];

	function makeRealClient(): AcpClient {
		return new AcpClient({
			agentName: "immediate-exit",
			config: {
				command: immediateExitCmd,
				args: immediateExitArgs,
			} as AcpAgentConfig,
		});
	}

	it("connect() OR initialize() rejects (within 3s) when the binary exits immediately with non-zero", async () => {
		// NOTE: This test must NOT use a 30s+ timeout — the entire point of
		// GAP-2 is fail-fast detection. We give 3s; a correct fix detects the
		// early 'exit' and rejects in milliseconds.
		// Use REAL spawn for this case so the binary's actual 'exit' event fires
		// (the file-level mock otherwise returns an inert EventEmitter that never
		// exits). makeRealClient()'s command is `false` (POSIX) / `cmd /c exit 1`.
		mockSpawn.mockImplementation((...args: any[]) => hoisted.realSpawn!(...args));
		const client = makeRealClient();

		let settled: "rejected" | "resolved" | "timeout" = "timeout";
		let err: unknown = null;
		const race = (async () => {
			try {
				await client.connect();
				await client.initialize();
				settled = "resolved";
			} catch (e) {
				settled = "rejected";
				err = e;
			}
		})();

		const watchdog = new Promise<void>((resolve) => setTimeout(resolve, 3000));
		await Promise.race([race, watchdog]);

		// Clean up any leftover process.
		try { await client.dispose(); } catch { /* ignore */ }

		expect(
			settled,
			"GAP-2: when the binary exists but exits non-zero immediately, " +
				"the client must reject fast (within 3s). " +
				`Observed: ${settled}` +
				(err ? ` err=${(err as Error)?.message}` : "") +
				" — currently the 'exit' event is ignored and initialize() hangs to timeout",
		).toBe("rejected");

		const msg = String((err as Error)?.message ?? "");
		// A classified, actionable error citing the command is the GREEN target.
		expect(msg).toMatch(/exit|spawn|exited|non-zero|immediate/i);
	});
});

// ===========================================================================
// GAP-4 — dispose() must install a no-op guard so the persistent
// proc.on('error') callback becomes inert post-dispose. Currently it clears
// spawnErrorListeners + spawnError but the callback still runs and re-sets
// this.spawnError on an already-disposed client. Harmless today but a
// latent footgun for future state additions in the callback.
// ===========================================================================

describe("RED GAP-4: proc.on('error') callback must be inert after dispose()", () => {
	it("late 'error' event after dispose() does NOT mutate client state", async () => {
		const proc = createMockProc();
		mockSpawn.mockReturnValue(proc);
		const client = makeClient();

		await client.connect();
		await client.dispose();

		// Simulate a late 'error' event from killWithEscalation / OS cleanup.
		const lateErr = Object.assign(new Error("spawn ESRCH after kill"), { code: "ESRCH" });
		proc.emit("error", lateErr);
		await Promise.resolve();

		// The GREEN invariant: spawnError must NOT be set on a disposed client.
		// The disposed flag should short-circuit the callback.
		const spawnErrorAfter = (client as any).spawnError as Error | null;
		expect(
			spawnErrorAfter,
			"GAP-4: proc.on('error') callback mutated spawnError on a disposed client — " +
				"dispose() must install a `disposed` guard so the callback is inert",
		).toBeNull();
	});

	it("calling connect() on a disposed client does not resurrect stale spawn-error state", async () => {
		const proc1 = createMockProc();
		mockSpawn.mockReturnValueOnce(proc1);
		const client = makeClient();
		await client.connect();
		await client.dispose();
		// Late error on dead proc1.
		proc1.emit("error", Object.assign(new Error("spawn stale"), { code: "ENOENT" }));
		await Promise.resolve();

		// New connect with a fresh proc.
		const proc2 = createMockProc();
		mockSpawn.mockReturnValueOnce(proc2);

		let rejected = false;
		try {
			await client.connect();
		} catch {
			rejected = true;
		}
		expect(
			rejected,
			"GAP-4: stale spawnError from a previous disposed lifecycle must NOT bleed " +
				"into a fresh connect() call",
		).toBe(false);
	});
});

// ===========================================================================
// GAP-3 (test-quality) and GAP-5 (doc-quality) — these are NOT new code-bug
// RED tests; they require FIXING existing tests/comments. Skipped here as
// TODO markers so the team that takes GREEN picks them up.
// ===========================================================================

describe.skip("RED GAP-3: AcpxAdapter guard test tests the WRONG binary (see test/spawn-enoent-red.test.ts)", () => {
	// INVARIANT the existing guard test CLAIMS but does NOT verify:
	//   The test in test/spawn-enoent-red.test.ts passes
	//   config.command = GHOST_BINARY but src/adapters/acpx.ts _runAcpx()
	//   always uses the hardcoded ACX_BINARY = "acpx" and ignores
	//   config.command entirely. So the test passes "by accident" (whichever
	//   of acpx/GHOST_BINARY is missing on the host) and does NOT lock the
	//   invariant its docstring claims ("a future refactor to async spawn()
	//   can't silently reintroduce the crash").
	//
	// FIX (GREEN team): either
	//   (a) mock spawnSync and assert it was called with the binary actually
	//       under test, OR
	//   (b) if AcpxAdapter is supposed to honor config.command, change the
	//       code to use opts.config.command and add a test that verifies it,
	//       OR
	//   (c) document that AcpxAdapter ALWAYS shells out to literal `acpx` and
	//       make the test target that binary explicitly.
	it("placeholder — see describe.skip body above", () => {
		expect(true).toBe(true);
	});
});

describe.skip("RED GAP-5: setImmediate claim in connect() docstring is too strong", () => {
	// The docstring on guardAgainstSpawnError() in src/core/client.ts claims:
	//   "That happens AFTER microtasks but WITHIN a single setImmediate cycle,
	//    so we yield one full event-loop iteration (setImmediate) to let any
	//    pending error surface before declaring connect() successful."
	//
	// This is an EMPIRICAL property of current Node/libuv on POSIX, NOT a
	// contract. Windows libuv backend timing is less deterministic; under
	// heavy event-loop load a single setImmediate can resolve before libuv
	// delivers the pending ENOENT (verified in review).
	//
	// FIX (GREEN team): soften the comment to "empirically sufficient on
	// POSIX; Windows untested" and consider a defensive second-turn check
	// (re-read this.spawnError after the await) so a slow-delivered error
	// still surfaces on the next call.
	it("placeholder — see describe.skip body above", () => {
		expect(true).toBe(true);
	});
});

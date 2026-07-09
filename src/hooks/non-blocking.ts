/**
 * NonBlockingRunner — wraps hook execution so the main workflow is never
 * blocked or crashed by a hook (R-H6).
 *
 * - Fire-and-forget: `run()` returns immediately; the hook executes in the
 *   background.
 * - Timeout enforcement: task_* hooks are raced against a timeout. On
 *   expiry the hook result is discarded and a warning is logged.
 * - Exception isolation: any throw / rejection is caught and logged — never
 *   propagates to the caller.
 * - Persist-allowlist: only `safety_block_result` and `rule_violation`
 *   results are persisted; everything else is UI-only.
 * - `dispose()`: cancels pending timers and marks the runner as disposed.
 *
 * Source of truth: flow/plans/acp-hooks-impl-spec.md (Non-blocking contract).
 */
import type { HookContext, HookEventName } from "./types.js";

/** Persist-allowlist — only these result types are durable. */
const PERSIST_ALLOWLIST: ReadonlySet<string> = new Set([
	"safety_block_result",
	"rule_violation",
]);

/** Events that run with timeout enforcement. */
const TIMEOUT_EVENTS: ReadonlySet<HookEventName> = new Set([
	"task_assigned",
	"task_completed",
	"task_failed",
]);

/** A hook result that may carry a persist directive. */
export interface HookResultWithPersist {
	persist?: boolean;
	type?: string;
	data?: unknown;
	[key: string]: unknown;
}

/** Logger interface accepted by NonBlockingRunner. */
export interface NonBlockingLogger {
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

/** Constructor options. */
export interface NonBlockingRunnerOptions {
	logger: NonBlockingLogger;
	defaultTimeoutMs?: number;
}

/** Options passed to `run()`. */
export interface RunOptions {
	context: HookContext;
	/** Per-call timeout override (only honored for task_* events). */
	timeoutMs?: number;
}

/** A hook function — may be sync or async, may return any value. */
export type HookFn = () => Promise<unknown> | unknown;

const DEFAULT_TIMEOUT_MS = 5000;
const NOOP_LOGGER: NonBlockingLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

/**
 * Fire-and-forget hook runner with timeout enforcement and exception isolation.
 */
export class NonBlockingRunner {
	private readonly logger: NonBlockingLogger;
	private readonly defaultTimeoutMs: number;
	private disposed = false;
	private pending = 0;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly persisted: HookResultWithPersist[] = [];

	constructor(opts: NonBlockingRunnerOptions) {
		this.logger = opts.logger ?? NOOP_LOGGER;
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * Run a hook in the background (fire-and-forget).
	 *
	 * Returns immediately — the hook's outcome never blocks or crashes the
	 * caller. After `dispose()`, this rejects with an error.
	 */
	run(event: HookEventName, fn: HookFn, opts: RunOptions): Promise<void> {
		if (this.disposed) {
			return Promise.reject(
				new Error("NonBlockingRunner has been disposed"),
			);
		}

		const timeoutMs = TIMEOUT_EVENTS.has(event)
			? (opts.timeoutMs ?? this.defaultTimeoutMs)
			: undefined;

		this.pending++;
		this.executeBackground(event, fn, opts.context, timeoutMs);

		return Promise.resolve(undefined);
	}

	/** Return the snapshot of persisted (allowlisted) hook results. */
	getPersistedResults(): HookResultWithPersist[] {
		return [...this.persisted];
	}

	/** Number of background hooks currently in flight. */
	pendingCount(): number {
		return this.pending;
	}

	/**
	 * Cancel all pending timers and mark the runner as disposed.
	 *
	 * Idempotent — safe to call multiple times. After dispose, `run()`
	 * rejects.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pending = 0;
		for (const t of this.timers) {
			clearTimeout(t);
		}
		this.timers.clear();
	}

	// ── Internals ──

	/**
	 * Background execution wrapper. The async IIFE starts synchronously so
	 * that sync throws / already-rejected promises schedule their catch
	 * continuation before `run()` returns (preserving microtask ordering
	 * for immediate-error assertions).
	 */
	private executeBackground(
		event: HookEventName,
		fn: HookFn,
		_context: HookContext,
		timeoutMs: number | undefined,
	): void {
		const p = (async () => {
			try {
				// Fix 7: guard against dispose racing in between enqueue and
				// execution — bail out before running the hook.
				if (this.disposed) return;
				const result =
					timeoutMs !== undefined
						? await this.runWithTimeout(fn, timeoutMs)
						: await fn();
				if (!this.disposed) {
					this.maybePersist(result);
				}
			} catch (err) {
				if (this.disposed) return;
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("timeout")) {
					this.logger.warn(msg, { event });
				} else {
					this.logger.error(msg, { event, error: err });
				}
			} finally {
				if (!this.disposed) {
					this.pending = Math.max(0, this.pending - 1);
				}
			}
		})();
		// Prevent unhandled-rejection (the try-catch above should make this a no-op).
		p.catch(() => {});
	}

	/**
	 * Race a hook's result against a timeout. Sync throws are rejected
	 * immediately (no extra microtask layer) so error logging isn't delayed.
	 */
	private runWithTimeout(
		fn: HookFn,
		timeoutMs: number,
	): Promise<unknown> {
		let resultPromise: unknown;
		try {
			resultPromise = fn();
		} catch (syncErr) {
			return Promise.reject(syncErr);
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.timers.delete(timer);
				reject(new Error(`hook timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			// Fix 7: unref so the timeout timer doesn't keep the event loop alive.
			timer.unref?.();
			this.timers.add(timer);

			Promise.resolve(resultPromise).then(
				(result) => {
					clearTimeout(timer);
					this.timers.delete(timer);
					resolve(result);
				},
				(err) => {
					clearTimeout(timer);
					this.timers.delete(timer);
					reject(err);
				},
			);
		});
	}

	/**
	 * Persist a hook result iff it is on the allowlist and flagged persist:true.
	 */
	private maybePersist(result: unknown): void {
		if (!result || typeof result !== "object") return;
		const r = result as HookResultWithPersist;
		if (
			r.persist === true &&
			typeof r.type === "string" &&
			PERSIST_ALLOWLIST.has(r.type)
		) {
			this.persisted.push(r);
		}
	}
}

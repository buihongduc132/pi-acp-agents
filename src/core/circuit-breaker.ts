/**
 * Circuit breaker + stall timeout + process kill escalation.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { CircuitState } from "../config/types.js";

export class CircuitOpenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CircuitOpenError";
	}
}

export class CircuitHalfOpenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CircuitHalfOpenError";
	}
}

export class AcpCircuitBreaker {
	private failures = 0;
	private _state: CircuitState = "closed";
	private lastFailureTime = 0;
	private probing = false; // EC-46: prevent concurrent half-open probes

	constructor(
		private maxFailures = 3,
		private resetTimeoutMs = 60_000,
		private stallTimeoutMs = 3_600_000, // 1 hour default
	) {}

	get state(): CircuitState {
		return this._state;
	}

	async execute<T>(fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
		// EC-46: prevent concurrent probes in half-open state
		if (this._state === "half-open" && this.probing) {
			throw new CircuitHalfOpenError(
				"Circuit half-open probe already in progress",
			);
		}

		if (this._state === "open") {
			if (Date.now() - this.lastFailureTime < this.resetTimeoutMs) {
				throw new CircuitOpenError("ACP agent circuit is open");
			}
			// Transition to half-open and mark that we're probing
			this._state = "half-open";
			this.probing = true;
		}

		try {
			// Wrap with stall timeout
			const effectiveTimeout = opts?.timeoutMs ?? this.stallTimeoutMs;
			const raceResult = await this.executeWithStallTimeout(fn, {
				stallTimeoutMs: effectiveTimeout,
				onCancel: async () => {
					// Cancel by throwing a timeout error
					throw new Error(`Operation stalled after ${effectiveTimeout}ms`);
				},
			});

			// Check if we timed out
			if (raceResult.stalled) {
				this.onFailure();
				this.probing = false; // Reset probing flag
				throw new Error(`Operation stalled after ${effectiveTimeout}ms`);
			}

			// Check if there was an error
			if (raceResult.error) {
				this.onFailure();
				this.probing = false; // Reset probing flag
				throw raceResult.error;
			}

			this.onSuccess();
			this.probing = false; // Reset probing flag on success
			return raceResult.result as T;
		} catch (err) {
			// Reset probing flag on any error
			this.probing = false;
			throw err;
		}
	}

	async executeWithStallTimeout<T>(
		fn: () => Promise<T>,
		opts: { stallTimeoutMs: number; onCancel: () => Promise<void> },
	): Promise<{ result?: T; stalled: boolean; error?: unknown }> {
		let settled = false;
		let resolveRace: (value: {
			result?: T;
			stalled: boolean;
			error?: unknown;
		}) => void;
		const racePromise = new Promise<{
			result?: T;
			stalled: boolean;
			error?: unknown;
		}>((resolve) => {
			resolveRace = resolve;
		});

		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				Promise.resolve(opts.onCancel())
					.catch(() => {
						// Stall timeout must still resolve even when cancellation fails.
					})
					.finally(() => {
						resolveRace!({ stalled: true });
					});
			}
		}, opts.stallTimeoutMs);

		fn()
			.then((result) => {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					resolveRace!({ result, stalled: false });
				}
			})
			.catch((err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					// Propagate error to caller
					resolveRace!({ stalled: false, error: err });
				}
			});

		return racePromise;
	}

	private onSuccess(): void {
		this.failures = 0;
		this._state = "closed";
	}

	private onFailure(): void {
		this.failures++;
		this.lastFailureTime = Date.now();
		if (this.failures >= this.maxFailures) this._state = "open";
	}
}

/** SIGTERM → SIGKILL escalation */
export function killWithEscalation(
	proc: ChildProcess,
	escalationMs = 5000,
): void {
	if (proc.killed) return;
	try {
		proc.kill("SIGTERM");
	} catch {
		// already dead
	}
	const timer = setTimeout(() => {
		try {
			if (!proc.killed) proc.kill("SIGKILL");
		} catch {
			// already dead
		}
	}, escalationMs);
	timer.unref();
}

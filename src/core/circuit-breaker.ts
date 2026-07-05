/**
 * Circuit breaker + stall timeout + process kill escalation.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { platform } from "node:os";
import type { CircuitState } from "../config/types.js";
import { AppError } from "./app-error.js";

export class CircuitOpenError extends AppError {
	constructor(message: string) {
		super("CIRCUIT_OPEN", message);
	}
}

export class CircuitHalfOpenError extends AppError {
	constructor(message: string) {
		super("CIRCUIT_HALF_OPEN", message);
	}
}

interface AgentCircuit {
	failures: number;
	state: CircuitState;
	lastFailureTime: number;
	probing: boolean;
}

export class AcpCircuitBreaker {
	// Per-agent circuit state
	private agents = new Map<string, AgentCircuit>();
	// Legacy global state for backward-compatible execute()
	private failures = 0;
	private _state: CircuitState = "closed";
	private lastFailureTime = 0;
	private probing = false; // EC-46: prevent concurrent half-open probes

	constructor(
		private maxFailures = 3,
		private resetTimeoutMs = 60_000,
		private stallTimeoutMs = 3_600_000, // 1 hour default
	) {
		// Intentional no-op: defaults are set via parameter properties
	}

	get state(): CircuitState {
		return this._state;
	}

	// --- Per-agent circuit breaker (for alias resolution) ---

	/** Check if a specific agent's circuit is healthy (closed or half-open) */
	isHealthy(agentName: string): boolean {
		const circuit = this.agents.get(agentName);
		if (!circuit) return true; // No history = healthy
		if (circuit.state === "open") {
			if (Date.now() - circuit.lastFailureTime < this.resetTimeoutMs) {
				return false;
			}
			// Reset timeout elapsed — will transition to half-open on next attempt
			return true;
		}
		return true; // closed or half-open = healthy
	}

	/** Record a success for a specific agent */
	recordSuccess(agentName: string): void {
		const circuit = this.getOrCreateAgent(agentName);
		circuit.failures = 0;
		circuit.state = "closed";
		circuit.probing = false;
	}

	/** Record a failure for a specific agent */
	recordFailure(agentName: string): void {
		const circuit = this.getOrCreateAgent(agentName);
		circuit.failures++;
		circuit.lastFailureTime = Date.now();
		circuit.probing = false;
		if (circuit.failures >= this.maxFailures) {
			circuit.state = "open";
		}
	}

	/** Get circuit state for a specific agent */
	getAgentState(agentName: string): CircuitState {
		const circuit = this.agents.get(agentName);
		if (!circuit) return "closed";
		// Check if open circuit should transition to half-open
		if (circuit.state === "open" && Date.now() - circuit.lastFailureTime >= this.resetTimeoutMs) {
			return "half-open";
		}
		return circuit.state;
	}

	private getOrCreateAgent(agentName: string): AgentCircuit {
		let circuit = this.agents.get(agentName);
		if (!circuit) {
			circuit = { failures: 0, state: "closed", lastFailureTime: 0, probing: false };
			this.agents.set(agentName, circuit);
		}
		return circuit;
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
				onCancel: () => Promise.reject(new Error(`Operation stalled after ${effectiveTimeout}ms`)),
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
				throw new Error(
					raceResult.error instanceof Error ? raceResult.error.message : String(raceResult.error),
					{ cause: raceResult.error },
				);
			}

			this.onSuccess();
			this.probing = false; // Reset probing flag on success
			return raceResult.result as T;
		} catch (err) {
			// Reset probing flag on any error
			this.probing = false;
			throw new Error(
				err instanceof Error ? err.message : String(err),
				{ cause: err },
			);
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

/**
 * On Windows: uses `taskkill /T /F /PID` to kill the entire process tree,
 * preventing orphaned child processes when `shell: true` was used in spawn().
 * On non-Windows: standard SIGTERM → SIGKILL escalation (unchanged).
 */
export function killWithEscalation(
	proc: ChildProcess,
	escalationMs = 5000,
): void {
	if (proc.killed) return;

	if (platform() === "win32") {
		// Windows: process-tree-aware kill via taskkill
		if (proc.pid != null) {
			try {
				execSync(`taskkill /T /F /PID ${proc.pid}`, { stdio: "ignore", timeout: escalationMs });
			} catch {
				// process may already be dead — taskkill returns non-zero
			}
		}
		return;
	}

	// Non-Windows: SIGTERM → SIGKILL escalation
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

/**
 * pi-acp-agents — Alias resolver with fallback chains.
 *
 * Resolves an alias name to a concrete agent using configurable
 * strategies: failover (sequential) or race (parallel, first wins).
 */
import type { AcpAliasConfig, AcpPromptResult } from "../config/types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AllAgentsFailedError extends Error {
	constructor(
		public readonly attempts: Array<{ agent: string; error: Error }>,
		aliasName: string,
	) {
		super(
			`All agents failed for alias "${aliasName}": ${attempts.map((a) => a.agent).join(", ")}`,
		);
		this.name = "AllAgentsFailedError";
	}
}

export class NoHealthyAgentsError extends Error {
	constructor(aliasName: string) {
		super(`No healthy agents for alias "${aliasName}"`);
		this.name = "NoHealthyAgentsError";
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DelegateFn = (
	agentName: string,
	message: string,
	cwd?: string,
) => Promise<AcpPromptResult>;

export type IsHealthyFn = (agentName: string) => boolean;

/** Called to cancel an in-flight request for a specific agent */
export type CancelFn = (agentName: string) => void;

/** Optional race strategy configuration */
export interface RaceOptions {
	raceTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// AliasResolver
// ---------------------------------------------------------------------------

export class AliasResolver {
	private readonly raceTimeoutMs: number;

	constructor(
		private readonly aliases: Record<string, AcpAliasConfig>,
		private readonly delegateFn: DelegateFn,
		private readonly isHealthyFn: IsHealthyFn,
		private readonly cancelFn?: CancelFn,
		private readonly raceOptions?: RaceOptions,
	) {
		this.raceTimeoutMs = raceOptions?.raceTimeoutMs ?? 30_000;
	}

	/**
	 * Resolve an alias to a concrete agent result.
	 *
	 * @throws Error if alias not found or has no agents
	 * @throws NoHealthyAgentsError if all agents are unhealthy (circuit open)
	 * @throws AllAgentsFailedError if all agents in the chain fail
	 */
	async resolve(
		aliasName: string,
		message: string,
		cwd?: string,
	): Promise<AcpPromptResult> {
		const alias = this.aliases[aliasName];
		if (!alias) throw new Error(`Alias "${aliasName}" not found`);
		if (!alias.agents || alias.agents.length === 0)
			throw new Error(`Alias "${aliasName}" has no agents`);

		// Filter healthy agents based on circuit breaker state
		const healthyAgents = alias.agents.filter((name) =>
			this.isHealthyFn(name),
		);

		if (alias.strategy === "race") {
			return this.race(aliasName, healthyAgents, message, cwd);
		}
		return this.failover(aliasName, healthyAgents, message, cwd);
	}

	// -------------------------------------------------------------------------
	// Failover: try agents sequentially, return on first success
	// -------------------------------------------------------------------------

	private async failover(
		aliasName: string,
		agents: string[],
		message: string,
		cwd?: string,
	): Promise<AcpPromptResult> {
		if (agents.length === 0) throw new NoHealthyAgentsError(aliasName);

		const attempts: Array<{ agent: string; error: Error }> = [];

		for (const agent of agents) {
			try {
				return await this.delegateFn(agent, message, cwd);
			} catch (err) {
				attempts.push({
					agent,
					error: err instanceof Error ? err : new Error(String(err)),
				});
			}
		}

		throw new AllAgentsFailedError(attempts, aliasName);
	}

	// -------------------------------------------------------------------------
	// Race: dispatch to all healthy agents in parallel, first response wins.
	// EC-1: Timeout guard — rejects if no agent responds within raceTimeoutMs.
	// EC-2: Cancels all losing agents once one wins (or on timeout).
	// -------------------------------------------------------------------------

	private async race(
		aliasName: string,
		agents: string[],
		message: string,
		cwd?: string,
	): Promise<AcpPromptResult> {
		if (agents.length === 0) throw new NoHealthyAgentsError(aliasName);

		// Track which agents have settled for cancellation
		const settledAgents = new Set<string>();

		return new Promise<AcpPromptResult>((resolve, reject) => {
			let resolved = false;
			let failureCount = 0;
			const attempts: Array<{ agent: string; error: Error }> = [];

			const cancelLosersAndSettle = (loserAgents: string[]) => {
				for (const loser of loserAgents) {
					if (!settledAgents.has(loser)) {
						this.cancelFn?.(loser);
					}
				}
			};

			// EC-1: Timeout guard — if no agent resolves within raceTimeoutMs, reject
			const timeoutId = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					cancelLosersAndSettle(agents);
					reject(new Error(`Race for alias "${aliasName}" timed out after ${this.raceTimeoutMs}ms — all agents hung`));
				}
			}, this.raceTimeoutMs);

			for (const agent of agents) {
				this.delegateFn(agent, message, cwd)
					.then((result) => {
						if (!resolved) {
							resolved = true;
							settledAgents.add(agent);
							clearTimeout(timeoutId);
							// EC-2: Cancel all other in-flight agents
							const losers = agents.filter((a) => a !== agent);
							cancelLosersAndSettle(losers);
							resolve(result);
						}
					})
					.catch((err) => {
						if (!resolved) {
							settledAgents.add(agent);
							attempts.push({
								agent,
								error: err instanceof Error ? err : new Error(String(err)),
							});
							failureCount++;
							if (failureCount === agents.length) {
								resolved = true;
								clearTimeout(timeoutId);
								reject(new AllAgentsFailedError(attempts, aliasName));
							}
						}
					});
			}
		});
	}
}

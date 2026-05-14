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

// ---------------------------------------------------------------------------
// AliasResolver
// ---------------------------------------------------------------------------

export class AliasResolver {
	constructor(
		private readonly aliases: Record<string, AcpAliasConfig>,
		private readonly delegateFn: DelegateFn,
		private readonly isHealthyFn: IsHealthyFn,
	) {}

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
	// Race: dispatch to all healthy agents in parallel, first response wins
	// -------------------------------------------------------------------------

	private async race(
		aliasName: string,
		agents: string[],
		message: string,
		cwd?: string,
	): Promise<AcpPromptResult> {
		if (agents.length === 0) throw new NoHealthyAgentsError(aliasName);

		return new Promise<AcpPromptResult>((resolve, reject) => {
			let settled = false;
			let failureCount = 0;
			const attempts: Array<{ agent: string; error: Error }> = [];

			for (const agent of agents) {
				this.delegateFn(agent, message, cwd)
					.then((result) => {
						if (!settled) {
							settled = true;
							resolve(result);
						}
					})
					.catch((err) => {
						if (!settled) {
							attempts.push({
								agent,
								error: err instanceof Error ? err : new Error(String(err)),
							});
							failureCount++;
							if (failureCount === agents.length) {
								settled = true;
								reject(new AllAgentsFailedError(attempts, aliasName));
							}
						}
					});
			}
		});
	}
}

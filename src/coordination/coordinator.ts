/**
 * pi-acp-agents — Agent Coordinator for Level 3 multi-agent operations.
 *
 * Provides delegate, broadcast, compare, and formatComparison operations
 * across multiple ACP agents. Each operation creates isolated adapter
 * instances that are disposed after use.
 */
import { createAdapter } from "../adapter-factory.js";
import { AliasResolver } from "./alias-resolver.js";
import type { AcpConfig, AcpPromptResult } from "../config/types.js";
import type { CancelFn } from "./alias-resolver.js";

/** Merge two AbortSignals — aborts when either one aborts */
function mergeSignals(
	a?: AbortSignal,
	b?: AbortSignal,
): AbortSignal | undefined {
	if (!a && !b) return undefined;
	if (a && !b) return a;
	if (!a && b) return b;
	const ctrl = new AbortController();
	if (a.aborted || b.aborted) {
		ctrl.abort();
		return ctrl.signal;
	}
	a.addEventListener("abort", () => ctrl.abort(), { once: true });
	b.addEventListener("abort", () => ctrl.abort(), { once: true });
	return ctrl.signal;
}

/** Progress update during delegation */
export interface AcpDelegateProgress {
  agentName: string;
  phase: "spawning" | "initializing" | "prompting" | "done" | "error";
  durationMs?: number;
  lastActivityAt?: number;
  text?: string;
}

/** Flat result from a single agent in a multi-agent operation */
export interface AgentResult {
  agent: string;
  text: string;
  sessionId: string;
  stopReason: string;
  error?: string;
}

/** Comparison result from multiple agents */
export interface ComparisonResult {
  prompt: string;
  responses: AgentResult[];
  timestamp: string;
}

export interface AgentCoordinatorDeps {
  /** Check if a specific agent's circuit breaker is healthy */
  isHealthyFn?: (agentName: string) => boolean;
  /** Record success/failure for circuit breaker tracking */
  recordSuccessFn?: (agentName: string) => void;
  recordFailureFn?: (agentName: string) => void;
}

export class AgentCoordinator {
  private isHealthyFn: (agentName: string) => boolean;
  private recordSuccessFn?: (agentName: string) => void;
  private recordFailureFn?: (agentName: string) => void;

  constructor(
    private config: AcpConfig,
    private cwd: string,
    deps?: AgentCoordinatorDeps,
  ) {
    this.isHealthyFn = deps?.isHealthyFn ?? (() => true);
    this.recordSuccessFn = deps?.recordSuccessFn;
    this.recordFailureFn = deps?.recordFailureFn;
  }

  /** Delegate a task to a single agent or alias. Creates a short-lived session. */
  async delegate(
    agentName: string,
    message: string,
    cwd?: string,
    onProgress?: (progress: AcpDelegateProgress) => void,
    signal?: AbortSignal,
  ): Promise<AcpPromptResult> {
    // Pre-aborted check
    if (signal?.aborted) {
      const adapter = this.createAdapterForAgent(agentName, cwd);
      try {
        adapter.cancel();
      } catch { /* best-effort */ }
      adapter.dispose();
      const err = new DOMException("Operation cancelled", "AbortError");
      onProgress?.({ agentName, phase: "error" });
      throw err;
    }

    // Check if it's an alias first
    const aliasConfig = this.config.agent_aliases?.[agentName];
    if (aliasConfig) {
      const isHealthy = this.isHealthyFn;
      const recordSuccess = this.recordSuccessFn;
      const recordFailure = this.recordFailureFn;
      // Build a cancelFn that can cancel in-flight delegate calls for this alias resolution
      const activeDelegates = new Map<string, { signal: AbortController }>();
      const cancelFn: CancelFn = (agentName: string) => {
        const entry = activeDelegates.get(agentName);
        if (entry) {
          entry.signal.abort();
          activeDelegates.delete(agentName);
        }
      };
      const resolver = new AliasResolver(
        { [agentName]: aliasConfig },
        async (name, msg, c) => {
          const ctrl = new AbortController();
          activeDelegates.set(name, { signal: ctrl });
          // Merge with outer signal if provided
          const merged = mergeSignals(signal, ctrl.signal);
          try {
            const result = await this.delegateToAgent(name, msg, c, onProgress, merged);
            recordSuccess?.(name);
            return result;
          } catch (err) {
            recordFailure?.(name);
            throw err;
          } finally {
            activeDelegates.delete(name);
          }
        },
        (name) => isHealthy(name),
        cancelFn,
        { raceTimeoutMs: this.config.raceTimeoutMs },
      );
      return resolver.resolve(agentName, message, cwd);
    }

    return this.delegateToAgent(agentName, message, cwd, onProgress, signal);
  }

  /** Create an adapter for a concrete agent. */
  private createAdapterForAgent(agentName: string, cwd?: string) {
    const agentCfg = this.config.agent_servers[agentName];
    if (!agentCfg) throw new Error(`Agent "${agentName}" not found`);
    const effectiveCwd = cwd ?? this.cwd;
    return createAdapter(agentName, agentCfg, this.config, effectiveCwd);
  }

  /** Delegate directly to a concrete agent. Creates a short-lived session. */
  private async delegateToAgent(
    agentName: string,
    message: string,
    cwd?: string,
    onProgress?: (progress: AcpDelegateProgress) => void,
    signal?: AbortSignal,
  ): Promise<AcpPromptResult> {
    const agentCfg = this.config.agent_servers[agentName];
    if (!agentCfg) throw new Error(`Agent "${agentName}" not found`);

    const effectiveCwd = cwd ?? this.cwd;
    const adapter = createAdapter(agentName, agentCfg, this.config, effectiveCwd);
    const startTime = Date.now();

    const emitProgress = (phase: AcpDelegateProgress["phase"]) => {
      onProgress?.({
        agentName,
        phase,
        durationMs: Date.now() - startTime,
        lastActivityAt: Date.now(),
      });
    };

    // Abort handler: cancel + dispose
    const onAbort = () => {
      try { adapter.cancel(); } catch { /* best-effort */ }
      adapter.dispose();
      emitProgress("error");
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      emitProgress("spawning");
      await adapter.spawn();
      emitProgress("initializing");
      await adapter.initialize();
      await adapter.newSession(effectiveCwd);
      emitProgress("prompting");
      return await adapter.prompt(message);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      adapter.dispose();
    }
  }

  /** Broadcast the same prompt to multiple agents in parallel. */
  async broadcast(
    agentNames: string[],
    message: string,
    cwd?: string,
  ): Promise<AgentResult[]> {
    const results = await Promise.allSettled(
      agentNames.map(async (name): Promise<AgentResult> => {
        try {
          const result = await this.delegate(name, message, cwd);
          return {
            agent: name,
            text: result.text,
            sessionId: result.sessionId,
            stopReason: result.stopReason,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            agent: name,
            text: "",
            sessionId: "",
            stopReason: "error",
            error: msg,
          };
        }
      }),
    );

    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { agent: "unknown", text: "", sessionId: "", stopReason: "error", error: String(r.reason) },
    );
  }

  /** Get responses from multiple agents and return structured comparison. */
  async compare(
    agentNames: string[],
    message: string,
    cwd?: string,
  ): Promise<ComparisonResult> {
    const responses = await this.broadcast(agentNames, message, cwd);
    return {
      prompt: message,
      responses,
      timestamp: new Date().toISOString(),
    };
  }

  /** Format a comparison result as readable text */
  formatComparison(comparison: {
    prompt: string;
    responses: Array<{
      agent: string;
      text?: string;
      sessionId?: string;
      stopReason?: string;
      error?: string;
    }>;
    timestamp: string;
  }): string {
    const lines = comparison.responses.map((r) => {
      if (r.error) {
        return `  ${r.agent}: (ERROR) ${r.error}`;
      }
      return `  ${r.agent}: ${r.text ?? "(no response)"}`;
    });

    return (
      `ACP Agent Comparison\n` +
      `────────────────────\n` +
      `Prompt: ${comparison.prompt}\n` +
      `Time:   ${comparison.timestamp}\n\n` +
      lines.join("\n")
    );
  }
}

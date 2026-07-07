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

/** Wrap a promise with a timeout. Throws on expiry with descriptive message. */
function withTimeoutMs<T>(promise: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  const effectiveMs = ms ?? 300_000;
  if (effectiveMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${effectiveMs}ms`)), effectiveMs);
    }),
  ]).finally(() => clearTimeout(timer));
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

/** Pooled adapter entry: adapter promise + per-adapter serialization lock. */
interface PooledAdapterEntry {
  adapterPromise: Promise<ReturnType<typeof createAdapter>>;
  /**
   * Promise chain for serializing prompts on this adapter.
   * ACP sessions handle one prompt at a time. Concurrent delegates to the
   * same agent must queue: each awaits the current lock, then replaces it
   * with a new promise that resolves when its prompt completes.
   */
  lock: Promise<void>;
}

export class AgentCoordinator {
  private isHealthyFn: (agentName: string) => boolean;
  private recordSuccessFn?: (agentName: string) => void;
  private recordFailureFn?: (agentName: string) => void;
  private adapterPool = new Map<string, PooledAdapterEntry>();

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
      try {
        adapter.dispose();
      } catch { /* best-effort — dispose must not throw */ }
      onProgress?.({ agentName, phase: "error" });
      throw new DOMException("Operation cancelled", "AbortError");
    }

    // Check if it's an alias first
    const aliasConfig = this.config.agent_aliases?.[agentName];
    if (aliasConfig) {
      const isHealthy = this.isHealthyFn;
      const recordSuccess = this.recordSuccessFn;
      const recordFailure = this.recordFailureFn;
      const resolver = new AliasResolver(
        { [agentName]: aliasConfig },
        async (name, msg, c) => {
          try {
            const result = await this.delegateToAgent(name, msg, c, onProgress, signal);
            recordSuccess?.(name);
            return result;
          } catch (err) {
            recordFailure?.(name);
            throw new Error(
              err instanceof Error ? err.message : String(err),
              { cause: err },
            );
          }
        },
        (name) => isHealthy(name),
        undefined,
        this.config.raceTimeoutMs ? { raceTimeoutMs: this.config.raceTimeoutMs } : undefined,
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

  /** Get or create a pooled adapter for an agent. Reuses warm connections. */
  private async getOrCreateAdapter(
    agentName: string,
    cwd?: string,
  ): Promise<PooledAdapterEntry> {
    const key = `${agentName}:${cwd ?? this.cwd}`;
    let entry = this.adapterPool.get(key);

    if (!entry) {
      const adapterPromise = this.createAndPrepareAdapter(agentName, cwd);
      entry = { adapterPromise, lock: Promise.resolve() };
      this.adapterPool.set(key, entry);
    } else {
      // Check if adapter is still healthy
      const adapter = await entry.adapterPromise;
      if (!adapter.connected) {
        // Evict and recreate
        this.adapterPool.delete(key);
        try { adapter.dispose(); } catch { /* best-effort */ }
        const adapterPromise = this.createAndPrepareAdapter(agentName, cwd);
        entry = { adapterPromise, lock: Promise.resolve() };
        this.adapterPool.set(key, entry);
      }
    }

    try {
      await entry.adapterPromise;
      return entry;
    } catch (err) {
      // Evict on error
      this.adapterPool.delete(key);
      throw err;
    }
  }

  /** Create and prepare a new adapter (spawn + initialize + newSession). */
  private async createAndPrepareAdapter(
    agentName: string,
    cwd?: string,
  ): Promise<ReturnType<typeof createAdapter>> {
    const agentCfg = this.config.agent_servers[agentName];
    if (!agentCfg) throw new Error(`Agent "${agentName}" not found`);
    const effectiveCwd = cwd ?? this.cwd;
    const adapter = createAdapter(agentName, agentCfg, this.config, effectiveCwd);

    await withTimeoutMs(
      adapter.spawn(),
      this.config.stallTimeoutMs,
      `acp_spawn(delegate:${agentName})`,
    );
    await adapter.initialize();
    await adapter.newSession(effectiveCwd);

    return adapter;
  }

  /** Drain the adapter pool — dispose every pooled adapter. Call on shutdown. */
  dispose(): void {
    for (const entry of this.adapterPool.values()) {
      entry.adapterPromise
        .then((adapter) => { try { adapter.dispose(); } catch { /* best-effort */ } })
        .catch(() => { /* ignore — creation failed, nothing to dispose */ });
    }
    this.adapterPool.clear();
  }

  /** Delegate directly to a concrete agent. Reuses pooled adapters. */
  private async delegateToAgent(
    agentName: string,
    message: string,
    cwd?: string,
    onProgress?: (progress: AcpDelegateProgress) => void,
    signal?: AbortSignal,
  ): Promise<AcpPromptResult> {
    const startTime = Date.now();

    const emitProgress = (phase: AcpDelegateProgress["phase"]) => {
      onProgress?.({
        agentName,
        phase,
        durationMs: Date.now() - startTime,
        lastActivityAt: Date.now(),
      });
    };

    emitProgress("spawning");

    // Pre-aborted check
    if (signal?.aborted) {
      emitProgress("error");
      throw new DOMException("Operation cancelled", "AbortError");
    }

    // Set up abort handler early — works for both creation and prompt phases.
    // On abort: cancel the adapter (best-effort) + reject.
    let abortReject: ((err: Error) => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {});

    let cachedAdapter: ReturnType<typeof createAdapter> | null = null;
    const onAbort = () => {
      if (cachedAdapter) {
        try { cachedAdapter.cancel(); } catch { /* best-effort */ }
      }
      emitProgress("error");
      abortReject?.(new DOMException("Operation cancelled", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // Race adapter creation against abort — covers abort-during-spawn.
      const entry = await Promise.race([
        this.getOrCreateAdapter(agentName, cwd),
        abortPromise,
      ]);
      const adapter = await entry.adapterPromise;
      cachedAdapter = adapter;

      // Serialize: wait for any in-flight prompt on this adapter to finish.
      // ACP sessions handle one prompt at a time; concurrent prompts on a
      // single session cause output cross-contamination.
      //
      // CRITICAL: capture the current lock and replace it with a NEW pending
      // promise BEFORE awaiting. If we await first, all concurrent callers
      // see the same resolved promise and all proceed simultaneously.
      const prevLock = entry.lock;
      let releaseLock!: () => void;
      entry.lock = new Promise<void>((r) => { releaseLock = r; });
      await prevLock;

      emitProgress("prompting");
      try {
        const promptPromise = adapter.prompt(message);
        promptPromise.catch(() => {});
        return await Promise.race([promptPromise, abortPromise]);
      } finally {
        releaseLock();
      }
    } catch (err) {
      // On any error (abort or prompt failure), evict adapter from pool so
      // the next delegate creates a fresh one.
      const key = `${agentName}:${cwd ?? this.cwd}`;
      const pooled = this.adapterPool.get(key);
      if (pooled) {
        this.adapterPool.delete(key);
        pooled.adapterPromise
          .then((a) => { try { a.dispose(); } catch { /* best-effort */ } })
          .catch(() => {});
      }
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
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

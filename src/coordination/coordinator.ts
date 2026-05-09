/**
 * pi-acp-agents — Agent Coordinator for Level 3 multi-agent operations.
 *
 * Provides delegate, broadcast, compare, and formatComparison operations
 * across multiple ACP agents. Each operation creates isolated adapter
 * instances that are disposed after use.
 */
import { createAdapter } from "../adapter-factory.js";
import type { AcpConfig, AcpPromptResult } from "../config/types.js";

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

export class AgentCoordinator {
  constructor(
    private config: AcpConfig,
    private cwd: string,
  ) {}

  /** Delegate a task to a single agent. Creates a short-lived session. */
  async delegate(
    agentName: string,
    message: string,
    cwd?: string,
  ): Promise<AcpPromptResult> {
    const agentCfg = this.config.agent_servers[agentName];
    if (!agentCfg) throw new Error(`Agent "${agentName}" not found`);

    const effectiveCwd = cwd ?? this.cwd;
    const adapter = createAdapter(agentName, agentCfg, this.config, effectiveCwd);
    try {
      await adapter.spawn();
      await adapter.initialize();
      await adapter.newSession(effectiveCwd);
      return await adapter.prompt(message);
    } finally {
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

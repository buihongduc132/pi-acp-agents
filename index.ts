import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { type AcpWidgetState, createAcpWidget } from "./src/acp-widget.js";
import { createAdapter } from "./src/adapter-factory.js";
import { loadConfig } from "./src/config/config.js";
import type { AcpArchivedSessionMetadata, AcpConfig, AcpPromptResult, AcpSessionHandle } from "./src/config/types.js";
import { AgentCoordinator } from "./src/coordination/coordinator.js";
import { AcpCircuitBreaker } from "./src/core/circuit-breaker.js";
import { HealthMonitor } from "./src/core/health-monitor.js";
import { getSessionAutoCloseReason } from "./src/core/session-lifecycle.js";
import { SessionManager } from "./src/core/session-manager.js";
import { createFileLogger } from "./src/logger.js";
import { AcpEventLog } from "./src/management/event-log.js";
import { GovernanceStore } from "./src/management/governance-store.js";
import { MailboxManager } from "./src/management/mailbox-manager.js";
import { AcpTaskStore, type AcpTaskStatus } from "./src/management/task-store.js";
import { SessionArchiveStore } from "./src/management/session-archive-store.js";
import { SessionNameStore } from "./src/management/session-name-store.js";
import { ensureRuntimeDir } from "./src/management/runtime-paths.js";
import { loadSettings, isToolEnabled, type AcpToolSettings } from "./src/settings/config.js";
import { configureToolSettings } from "./src/settings/configure-tui.js";

function textContent(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function normalizeOptionalSessionName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, "session_name");
}

export default function (pi: ExtensionAPI) {
  const sessionMgr = new SessionManager();
  const activeAdapters = new Map<string, ReturnType<typeof createAdapter>>();
  const busySessions = new Map<string, boolean>();
  const DELEGATION_HISTORY_CAP = 20;
  const widgetActivity = {
    activeDelegations: 0,
    activeBroadcasts: 0,
    activeCompares: 0,
    delegations: [] as Array<{ id: string; agentName: string; phase: string; startedAt: Date; lastActivityAt: Date; text?: string }>,
    delegationHistory: [] as Array<{ agentName: string; status: "completed" | "error"; error?: string; sessionId?: string; finishedAt: Date }>,
    lastError: undefined as string | undefined,
  };

  let config: AcpConfig = loadConfig();
  let widgetRegistered = false;

  const logsDir = config.logsDir ?? join(homedir(), ".pi", "acp-agents", "logs");
  const logger = createFileLogger(logsDir);
  const runtimePaths = ensureRuntimeDir(config.runtimeDir);
  const eventLog = new AcpEventLog(runtimePaths.rootDir);
  const taskStore = new AcpTaskStore(runtimePaths.rootDir);
  const mailboxManager = new MailboxManager(runtimePaths.rootDir);
  const governanceStore = new GovernanceStore(runtimePaths.rootDir);
  const sessionArchiveStore = new SessionArchiveStore(runtimePaths.rootDir);
  const sessionNameStore = new SessionNameStore(runtimePaths.rootDir);
  governanceStore.setModelPolicy(config.modelPolicy ?? {});

  const cb = new AcpCircuitBreaker(
    config.circuitBreakerMaxFailures ?? 3,
    config.circuitBreakerResetMs ?? 60_000,
    config.stallTimeoutMs ?? 300_000,
  );

  function archiveSession(handle: AcpSessionHandle): AcpArchivedSessionMetadata {
    return sessionArchiveStore.upsert(handle);
  }

  async function closeSession(handle: AcpSessionHandle, closeReason: string, autoClosed = false): Promise<void> {
    handle.autoClosed = autoClosed;
    handle.closeReason = closeReason;
    archiveSession(handle);
    await sessionMgr.remove(handle.sessionId);
    activeAdapters.delete(handle.sessionId);
    busySessions.delete(handle.sessionId);
    eventLog.append("session_closed", { sessionId: handle.sessionId, agentName: handle.agentName, closeReason, autoClosed });
  }

  function markPromptLifecycle(handle: AcpSessionHandle, promptResult: AcpPromptResult): void {
    const now = new Date();
    handle.lastActivityAt = now;
    handle.lastResponseAt = now;
    handle.completedAt = now;
    handle.autoClosed = false;
    handle.closeReason = undefined;
    handle.accumulatedText += promptResult.text;
    archiveSession(handle);
  }

  function getArchivedSession(sessionId: string): AcpArchivedSessionMetadata | undefined {
    return sessionArchiveStore.get(sessionId);
  }

  function findLiveSessionByName(sessionName: string): AcpSessionHandle | undefined {
    return sessionMgr.list().find((session) => session.sessionName === sessionName);
  }

  function findArchivedSessionByName(sessionName: string): AcpArchivedSessionMetadata | undefined {
    const resolvedSessionId = sessionNameStore.getSessionId(sessionName);
    if (resolvedSessionId) {
      return getArchivedSession(resolvedSessionId);
    }
    const live = findLiveSessionByName(sessionName);
    if (live) return live;
    return undefined;
  }

  function getSessionMetadata(sessionId: string): AcpArchivedSessionMetadata | AcpSessionHandle | undefined {
    return sessionMgr.get(sessionId) ?? getArchivedSession(sessionId);
  }

  function resolveSessionTarget(params: { session_id?: string; session_name?: string }): {
    sessionId?: string;
    sessionName?: string;
    metadata?: AcpArchivedSessionMetadata | AcpSessionHandle;
  } {
    const sessionId = params.session_id?.trim();
    const sessionName = normalizeOptionalSessionName(params.session_name);
    const byId = sessionId ? getSessionMetadata(sessionId) : undefined;
    const mappedSessionId = sessionName ? sessionNameStore.getSessionId(sessionName) : undefined;
    const byName = sessionName ? findLiveSessionByName(sessionName) ?? (mappedSessionId ? getSessionMetadata(mappedSessionId) : undefined) : undefined;
    if (sessionId && sessionName && byName && byName.sessionId !== sessionId) {
      if (!byId) {
        throw new Error(`session_id "${sessionId}" was not found and does not match resolved session_name "${sessionName}".`);
      }
      throw new Error(`session_id "${sessionId}" does not match session_name "${sessionName}".`);
    }
    if (sessionId) {
      return { sessionId, sessionName: byId?.sessionName ?? sessionNameStore.getName(sessionId) ?? sessionName, metadata: byId };
    }
    if (byName) {
      return { sessionId: byName.sessionId, sessionName, metadata: byName };
    }
    return { sessionId, sessionName, metadata: undefined };
  }

  const monitor = new HealthMonitor({
    intervalMs: config.healthCheckIntervalMs ?? 5_000,
    staleTimeoutMs: config.staleTimeoutMs ?? 3_600_000,
    needsAttentionMs: config.needsAttentionMs ?? 60_000,
    autoInterruptMs: config.autoInterruptMs ?? 300_000,
    interruptGraceMs: config.interruptGraceMs ?? 10_000,
    async onNeedsAttention(sessionId: string) {
      // UI notification only — don't interrupt
      const handle = sessionMgr.get(sessionId);
      if (handle) {
        eventLog.append('session_needs_attention', { sessionId, agentName: handle.agentName });
      }
    },
    async onStale(sessionId: string) {
      const handle = sessionMgr.get(sessionId);
      if (!handle) return;

      // Check if this is a prompt stall (activity-based) vs idle stale
      const isPromptStall = handle.isPrompting === true;
      const closeReason = getSessionAutoCloseReason(handle, config.staleTimeoutMs ?? 3_600_000);

      if (isPromptStall) {
        // Escalation: cancel → grace → kill
        eventLog.append('session_stalled_prompt', { sessionId, agentName: handle.agentName });
        try {
          const adapter = activeAdapters.get(sessionId);
          if (adapter) {
            await adapter.cancel();
            await new Promise(resolve => setTimeout(resolve, config.interruptGraceMs ?? 10_000));
          }
        } catch (e) {
          // cancel() can throw if process already dead — proceed to kill
          logger.debug("cancel during stall interrupt failed", e);
        }
        handle.isPrompting = false;
        monitor.markPromptEnd(sessionId);
        await closeSession(handle, 'stalled-prompt-auto-interrupt', true);
        eventLog.append('session_stalled_prompt_killed', { sessionId });
      } else if (closeReason) {
        // Existing idle/disposed handling
        logger.info('session stale, disposing', { sessionId, closeReason });
        await closeSession(handle, closeReason, true);
        eventLog.append('session_stale', { sessionId, closeReason });
      }
    },
  });
  monitor.start();

  const getWidgetState = (): AcpWidgetState => ({
    sessions: sessionMgr.list().map((s) => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      agentName: s.agentName,
      cwd: s.cwd,
      status: s.disposed
        ? "error"
        : busySessions.get(s.sessionId)
          ? "active"
          : getSessionAutoCloseReason(s, config.staleTimeoutMs ?? 3_600_000)
            ? "stale"
            : "idle",
      lastActivityAt: s.lastActivityAt,
      createdAt: s.createdAt,
      model: s.model,
    })),
    circuitBreakerState: cb.state as "closed" | "open" | "half-open",
    configuredAgentNames: Object.keys(config.agent_servers),
    configuredAliases: config.agent_aliases ? Object.keys(config.agent_aliases) : [],
    defaultAgent: config.defaultAgent,
    activity: { ...widgetActivity },
  });

  const widgetFactory = createAcpWidget({ getState: getWidgetState });

  function ensureWidget(ctx: { ui: { setWidget: Function } }) {
    if (widgetRegistered) return;
    try {
      ctx.ui.setWidget("pi-acp-agents", widgetFactory);
      widgetRegistered = true;
    } catch (e) {
      // Widget registration may fail if UI not ready
      logger.debug("widget registration failed", e);
    }
  }

  function refreshWidget(ctx: { ui: { setWidget: Function } }) {
    if (!widgetRegistered) {
      ensureWidget(ctx);
      return;
    }
    try {
      ctx.ui.setWidget("pi-acp-agents", widgetFactory);
    } catch (e) {
      // Widget refresh may fail if UI not ready
      logger.debug("widget refresh failed", e);
    }
  }

  function setWidgetError(error: string | undefined): void {
    widgetActivity.lastError = error ? error.slice(0, 120) : undefined;
  }

  function beginWidgetActivity(kind: "delegate" | "broadcast" | "compare", ctx: { ui: { setWidget: Function } }): void {
    setWidgetError(undefined);
    if (kind === "delegate") widgetActivity.activeDelegations += 1;
    if (kind === "broadcast") widgetActivity.activeBroadcasts += 1;
    if (kind === "compare") widgetActivity.activeCompares += 1;
    refreshWidget(ctx);
  }

  function endWidgetActivity(
    kind: "delegate" | "broadcast" | "compare",
    ctx: { ui: { setWidget: Function } },
    error?: string,
  ): void {
    if (kind === "delegate") widgetActivity.activeDelegations = Math.max(0, widgetActivity.activeDelegations - 1);
    if (kind === "broadcast") widgetActivity.activeBroadcasts = Math.max(0, widgetActivity.activeBroadcasts - 1);
    if (kind === "compare") widgetActivity.activeCompares = Math.max(0, widgetActivity.activeCompares - 1);
    setWidgetError(error);
    refreshWidget(ctx);
  }

  function makeSessionHandle(
    sessionId: string,
    agentName: string,
    cwd: string,
    adapter: ReturnType<typeof createAdapter>,
    metadata?: Partial<AcpArchivedSessionMetadata>,
    sessionName?: string,
  ): AcpSessionHandle {
    const now = metadata?.createdAt ?? new Date();
    const handle: AcpSessionHandle = {
      sessionId,
      sessionName: sessionName ?? metadata?.sessionName ?? sessionNameStore.getName(sessionId),
      agentName,
      cwd,
      createdAt: now,
      lastActivityAt: metadata?.lastActivityAt ?? now,
      lastResponseAt: metadata?.lastResponseAt,
      completedAt: metadata?.completedAt,
      accumulatedText: "",
      disposed: false,
      busy: false,
      autoClosed: metadata?.autoClosed,
      closeReason: metadata?.closeReason,
      model: metadata?.model,
      mode: metadata?.mode,
      planStatus: "none",
      dispose: async () => {
        handle.disposed = true;
        archiveSession(handle);
        adapter.dispose();
        activeAdapters.delete(sessionId);
      },
    };
    sessionMgr.add(handle);
    monitor.register(handle);
    activeAdapters.set(sessionId, adapter);
    archiveSession(handle);
    eventLog.append("session_created", { sessionId, agentName, cwd });
    return handle;
  }

  async function safeExecute<T>(
    fn: () => Promise<T>,
    label: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: true; value: T } | { ok: false; error: string; circuitOpen?: boolean }> {
    try {
      const value = await cb.execute(fn, opts);
      return { ok: true, value };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const circuitOpen = err instanceof Error && err.name === "CircuitOpenError";
      logger.error(`error in ${label}`, { error: msg });
      eventLog.append("operation_error", { label, error: msg, circuitOpen });
      return { ok: false, error: msg, circuitOpen };
    }
  }

  function getAgentName(requested?: string): string {
    return requested ?? config.defaultAgent ?? Object.keys(config.agent_servers)[0] ?? "";
  }

  /** Check if a name is an alias */
  function isAlias(name: string): boolean {
    return !!config.agent_aliases?.[name];
  }

  /** Get the first agent name from an alias chain */
  function resolveAliasToAgent(aliasName: string): string {
    const alias = config.agent_aliases?.[aliasName];
    if (!alias?.agents?.length) return aliasName;
    return alias.agents[0];
  }

  function getAgentConfigOrThrow(agentName: string) {
    // If it's an alias, resolve to first agent in chain
    if (isAlias(agentName)) {
      const resolved = resolveAliasToAgent(agentName);
      const agentCfg = config.agent_servers[resolved];
      if (!agentCfg) {
        throw new Error(`Alias \"${agentName}\" resolves to agent \"${resolved}\" which is not found. Available: ${Object.keys(config.agent_servers).join(", ") || "none"}`);
      }
      return agentCfg;
    }
    const agentCfg = config.agent_servers[agentName];
    if (!agentCfg) {
      throw new Error(`Agent \"${agentName}\" not found. Available: ${Object.keys(config.agent_servers).join(", ") || "none"}`);
    }
    return agentCfg;
  }

  function renderSessionSummary(handle: AcpArchivedSessionMetadata | AcpSessionHandle): string {
    return [
      `Session: ${handle.sessionId}`,
      `Name:    ${handle.sessionName ?? "(none)"}`,
      `Agent:   ${handle.agentName}`,
      `CWD:     ${handle.cwd}`,
      `Created: ${handle.createdAt.toISOString()}`,
      `Active:  ${handle.lastActivityAt.toISOString()}`,
      `Response:${handle.lastResponseAt ? ` ${handle.lastResponseAt.toISOString()}` : " (none)"}`,
      `Done:    ${handle.completedAt ? handle.completedAt.toISOString() : "(none)"}`,
      `Busy:    ${busySessions.get(handle.sessionId) ? "yes" : "no"}`,
      `Plan:    ${(handle as AcpSessionHandle).planStatus ?? "none"}`,
      `Closed:  ${handle.closeReason ?? "open"}`,
      `Disposed:${handle.disposed ? " yes" : " no"}`,
    ].join("\n");
  }

  // Load tool visibility settings
  const toolSettings: AcpToolSettings = loadSettings(process.cwd());

  // Core tools
  if (isToolEnabled(toolSettings, "acp_prompt")) pi.registerTool({
    name: "acp_prompt",
    label: "ACP Prompt",
    description: "Send a prompt to an ACP-compatible agent (e.g., Gemini CLI). Returns the agent's text response. Creates a new session if needed.",
    promptSnippet: "acp_prompt — send a prompt to an ACP agent and get the response",
    parameters: Type.Object({
      message: Type.String({ description: "The message/prompt to send to the agent" }),
      agent: Type.Optional(Type.String({ description: "Agent name from config. Default: use defaultAgent setting" })),
      session_id: Type.Optional(Type.String({ description: "Existing session ID to reuse" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name to reuse or assign when creating" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
      dispose: Type.Optional(Type.Boolean({ description: "Create ephemeral session and dispose after response" })),
      model: Type.Optional(Type.String({ description: "Model to set on the session" })),
      mode: Type.Optional(Type.String({ description: "Mode/thinking level to set on the session" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentName = getAgentName(params.agent);
      try {
        getAgentConfigOrThrow(agentName);
      } catch (error) {
        return { content: [textContent(String((error as Error).message))], details: { agent: agentName, error: "not found" } };
      }

      const result = await safeExecute(async () => {
        const target = resolveSessionTarget(params);
        if (target.sessionId && activeAdapters.has(target.sessionId)) {
          const handle = sessionMgr.get(target.sessionId);
          if (!handle || handle.disposed) {
            throw new Error(`Session \"${target.sessionId}\" not found or disposed.`);
          }
          if (busySessions.get(target.sessionId)) {
            throw new Error(`Session \"${target.sessionId}\" is busy. Try again later.`);
          }
          busySessions.set(target.sessionId, true);
          handle.busy = true;
          handle.lastActivityAt = new Date();
          handle.isPrompting = true;
          handle.promptStartedAt = new Date();
          monitor.markPromptStart(target.sessionId);
          archiveSession(handle);
          try {
            const adapter = activeAdapters.get(target.sessionId)!;
            const promptResult = (await withTimeoutMs(adapter.prompt(params.message), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `acp_prompt(reused:${target.sessionId})`)) as AcpPromptResult;
            markPromptLifecycle(handle, promptResult);
            eventLog.append("prompt_reused_session", { agentName, sessionId: target.sessionId, sessionName: handle.sessionName });
            return { ...promptResult, sessionId: target.sessionId, sessionName: handle.sessionName };
          } finally {
            busySessions.delete(target.sessionId);
            handle.busy = false;
            handle.isPrompting = false;
            monitor.markPromptEnd(target.sessionId);
            archiveSession(handle);
          }
        }

        if (target.sessionId && target.metadata) {
          // Auto-reload archived session if it exists
          const archived = target.metadata;
            const agentCfg = getAgentConfigOrThrow(agentName);
            const adapter = createAdapter(agentName, agentCfg, config, params.cwd ?? ctx.cwd, {
              onActivity: (sid) => monitor.touch(sid),
            });
            try {
              await withTimeoutMs(adapter.spawn(), config.stallTimeoutMs, `acp_spawn(archived:${target.sessionId})`);
              await adapter.initialize();
              try {
                await adapter.loadSession(target.sessionId);
              } catch (loadErr) {
                // Archived session cannot be reloaded — fall back to fresh
                adapter.dispose();
                const freshAdapter = createAdapter(agentName, agentCfg, config, params.cwd ?? ctx.cwd, {
                  onActivity: (sid) => monitor.touch(sid),
                });
                try {
                  await withTimeoutMs(freshAdapter.spawn(), config.stallTimeoutMs, `acp_spawn(fresh:${target.sessionId})`);
                  await freshAdapter.initialize();
                  const freshSessionId = await freshAdapter.newSession(params.cwd ?? ctx.cwd);
                  if (target.sessionName) sessionNameStore.register(target.sessionName, freshSessionId);
                  const handle = makeSessionHandle(freshSessionId, agentName, params.cwd ?? ctx.cwd, freshAdapter, undefined, target.sessionName);
                  handle.busy = true; busySessions.set(freshSessionId, true);
                  try {
                    const pr = (await withTimeoutMs(freshAdapter.prompt(params.message), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `acp_prompt(fresh:${freshSessionId})`)) as AcpPromptResult;
                    markPromptLifecycle(handle, pr);
                    pr.text = `[warning: archived session could not be reloaded: ${(loadErr as Error).message}]\n${pr.text}`;
                    return { ...pr, sessionId: freshSessionId, sessionName: handle.sessionName };
                  } finally {
                    busySessions.delete(freshSessionId); handle.busy = false; archiveSession(handle);
                  }
                } catch (freshErr) { freshAdapter.dispose(); throw freshErr; }
              }
              const handle = makeSessionHandle(target.sessionId, agentName, archived.cwd ?? params.cwd ?? ctx.cwd, adapter, undefined, target.sessionName);
              handle.busy = true; busySessions.set(target.sessionId, true);
              try {
                const pr = (await withTimeoutMs(adapter.prompt(params.message), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `acp_prompt(archived:${target.sessionId})`)) as AcpPromptResult;
                markPromptLifecycle(handle, pr);
                return { ...pr, sessionId: target.sessionId, sessionName: handle.sessionName };
              } finally {
                busySessions.delete(target.sessionId); handle.busy = false; archiveSession(handle);
              }
            } catch (err) { adapter.dispose(); throw err; }
          throw new Error(`Session name "${target.sessionName ?? params.session_name}" refers to archived session "${target.sessionId}". Load it first with acp_session_load or use the raw session_id of a live session.`);
        }
        const agentCfg = getAgentConfigOrThrow(agentName);
        const adapter = createAdapter(agentName, agentCfg, config, params.cwd ?? ctx.cwd, {
          onActivity: (sid) => monitor.touch(sid),
        });
        try {
          await withTimeoutMs(adapter.spawn(), config.stallTimeoutMs, `acp_spawn(new:${agentName})`);
          await adapter.initialize();
          const sessionId = await adapter.newSession(params.cwd ?? ctx.cwd);
          if (params.model) await adapter.setModel(params.model);
          if (params.mode) await adapter.setMode(params.mode);
          if (target.sessionName && !params.dispose) {
            sessionNameStore.register(target.sessionName, sessionId);
          }
          const handle = makeSessionHandle(sessionId, agentName, params.cwd ?? ctx.cwd, adapter, undefined, params.dispose ? undefined : target.sessionName);
          handle.busy = true;
          busySessions.set(sessionId, true);
          handle.lastActivityAt = new Date();
          handle.isPrompting = true;
          handle.promptStartedAt = new Date();
          monitor.markPromptStart(sessionId);
          archiveSession(handle);
          try {
            const promptResult = (await withTimeoutMs(adapter.prompt(params.message), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `acp_prompt(new:${sessionId})`)) as AcpPromptResult;
            markPromptLifecycle(handle, promptResult);
            eventLog.append("prompt_new_session", { agentName, sessionId, sessionName: handle.sessionName });
            return { ...promptResult, sessionId, sessionName: handle.sessionName };
          } finally {
            busySessions.delete(sessionId);
            handle.busy = false;
            handle.isPrompting = false;
            monitor.markPromptEnd(sessionId);
            archiveSession(handle);
            if (params.dispose) adapter.dispose();
          }
        } catch (err) {
          adapter.dispose();
          throw err;
        }
      }, `acp_prompt(${agentName})`);

      refreshWidget(ctx);
      if (result.ok) {
        return {
          content: [textContent(result.value.text || "(no response)")],
          details: {
            sessionId: result.value.sessionId,
            sessionName: result.value.sessionName,
            stopReason: result.value.stopReason,
            agent: agentName,
          },
        } as AgentToolResult<{ sessionId: string; stopReason: string; agent: string }>;
      }

      const prefix = result.circuitOpen ? "Circuit breaker open — too many failures. Retry later.\n" : "";
      return {
        content: [textContent(`${prefix}ACP error (${agentName}): ${result.error}`)],
        details: { sessionId: "", sessionName: params.session_name, stopReason: "error", agent: agentName },
      };
    },
  });

  if (isToolEnabled(toolSettings, "acp_status")) pi.registerTool({
      name: "acp_status",
    label: "ACP Status",
    description: "Check the status of ACP agent connections. Shows configured agents and active sessions.",
    promptSnippet: "acp_status — check ACP agent and session status",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Specific session ID to inspect" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name to inspect" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      config = loadConfig();
      governanceStore.setModelPolicy(config.modelPolicy ?? {});
      if (params.session_id || params.session_name) {
        let target;
        try {
          target = resolveSessionTarget(params);
        } catch (error) {
          return {
            content: [textContent(String((error as Error).message))],
            details: { circuitBreaker: cb.state, agentCount: Object.keys(config.agent_servers).length, sessionCount: sessionMgr.size },
          };
        }
        const handle = target.metadata;
        if (!handle || !target.sessionId) {
          return {
            content: [textContent(`Session \"${params.session_name ?? params.session_id}\" not found.`)],
            details: { circuitBreaker: cb.state, agentCount: Object.keys(config.agent_servers).length, sessionCount: sessionMgr.size },
          };
        }
        refreshWidget(ctx);
        return {
          content: [textContent(renderSessionSummary(handle))],
          details: { circuitBreaker: cb.state, agentCount: Object.keys(config.agent_servers).length, sessionCount: sessionMgr.size },
        };
      }

      const agentLines = Object.entries(config.agent_servers)
        .map(([name, cfg]) => `  ${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")}`)
        .join("\n");
      const sessionLines = sessionMgr.list().map((s) => `  ${s.sessionName ? `${s.sessionName} ` : ""}${s.sessionId} (${s.agentName}) — ${s.cwd}`).join("\n");
      refreshWidget(ctx);
      return {
        content: [textContent(
          `ACP Agent Servers Status\n─────────────────\nCircuit Breaker: ${cb.state}\nAgent Servers: ${Object.keys(config.agent_servers).length} configured\nAliases: ${config.agent_aliases ? Object.keys(config.agent_aliases).length : 0}\nDefault: ${config.defaultAgent ?? "none"}\n\nAgent Servers:\n${agentLines || "  (none)"}${config.agent_aliases ? `\n\nAliases:\n${Object.entries(config.agent_aliases).map(([name, cfg]) => `  ${name} → [${cfg.agents.join(", ")}] (${cfg.strategy})`).join("\n")}` : ""}\n\nActive Sessions (${sessionMgr.size}):\n${sessionLines || "  (none)"}`,
        )],
        details: { circuitBreaker: cb.state, agentCount: Object.keys(config.agent_servers).length, sessionCount: sessionMgr.size },
      };
    },
  });

  // Session lifecycle tools — moved to pi-acp-advanced extension


  if (isToolEnabled(toolSettings, "acp_cancel")) pi.registerTool({
      name: "acp_cancel",
    label: "ACP Cancel",
    description: "Cancel an ongoing prompt on an ACP agent session.",
    promptSnippet: "acp_cancel — cancel ongoing ACP prompt",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session ID to cancel" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name to cancel" })),
    }),
    async execute(_toolCallId, params) {
      const target = resolveSessionTarget(params);
      const handle = target.sessionId ? sessionMgr.get(target.sessionId) : undefined;
      if (!handle || handle.disposed) {
        return { content: [textContent(`Session \"${target.sessionName ?? target.sessionId ?? params.session_name ?? params.session_id}\" not found or disposed.`)], details: { sessionId: target.sessionId, sessionName: target.sessionName, cancelled: false } };
      }
      const result = await safeExecute(async () => {
        const adapter = activeAdapters.get(handle.sessionId)!;
        await adapter.cancel();
        const now = new Date();
        handle.lastActivityAt = now;
        handle.completedAt = now;
        archiveSession(handle);
        eventLog.append("session_cancel", { sessionId: handle.sessionId, sessionName: handle.sessionName });
        return true;
      }, "acp_cancel");
      if (result.ok) {
        return { content: [textContent(`Cancelled prompt on session ${handle.sessionId}`)], details: { sessionId: handle.sessionId, sessionName: handle.sessionName, cancelled: true } };
      }
      return { content: [textContent(`Failed to cancel: ${result.error}`)], details: { sessionId: handle.sessionId, sessionName: handle.sessionName, cancelled: false } };
    },
  });

  // Level 3 tools

  if (isToolEnabled(toolSettings, "acp_broadcast")) pi.registerTool({
      name: "acp_broadcast",
    label: "ACP Broadcast",
    description: "Send the same prompt to multiple ACP agents in parallel. Returns each agent's response. Individual failures don't affect others.",
    promptSnippet: "acp_broadcast — broadcast to multiple ACP agents",
    parameters: Type.Object({
      message: Type.String({ description: "Prompt to send to all agents" }),
      agents: Type.Optional(Type.Array(Type.String(), { description: "Agent names. Default: all configured agents" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentNames = params.agents ?? Object.keys(config.agent_servers);
      if (agentNames.length === 0) {
        return { content: [textContent("No agent servers configured or specified.")], details: { results: [], error: "no agents" } };
      }
      const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd, {
        isHealthyFn: (name) => cb.isHealthy(name),
        recordSuccessFn: (name) => cb.recordSuccess(name),
        recordFailureFn: (name) => cb.recordFailure(name),
      });
      beginWidgetActivity("broadcast", ctx);
      const result = await safeExecute(async () => {
        const output = await coordinator.broadcast(agentNames, params.message, params.cwd ?? ctx.cwd);
        eventLog.append("broadcast", { agentNames, cwd: params.cwd ?? ctx.cwd });
        return output;
      }, `acp_broadcast(${agentNames.join(",")})`, { timeoutMs: config.toolTimeouts?.broadcast ?? config.stallTimeoutMs });
      if (!result.ok) {
        endWidgetActivity("broadcast", ctx, result.error);
        return { content: [textContent(`Broadcast failed: ${result.error}`)], details: { results: [], error: result.error, circuitOpen: result.circuitOpen } };
      }
      const lines = result.value.map((r) => r.error ? `── ${r.agent} ──\n(ERROR: ${r.error})` : `── ${r.agent} ──\n${r.text}`);
      endWidgetActivity("broadcast", ctx);
      return { content: [textContent(`Broadcast results:\n\n${lines.join("\n\n")}`)], details: { results: result.value } };
    },
  });


  // Parallel delegation tool

  // ── Consolidated tools (33→7 mode) ──
  if (isToolEnabled(toolSettings, "acp_task_update")) pi.registerTool({
      name: "acp_task_update",
    label: "ACP Task Update",
    description: "Update task status, assignee, dependencies, or result. Consolidates acp_task_assign, acp_task_set_status, acp_task_dep_add/rm, acp_task_clear. Supports bulk ops with task_id='*'.",
    promptSnippet: "acp_task_update — update task properties",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID, or '*' for bulk operations" }),
      status: Type.Optional(Type.String({ description: "New status: pending, in_progress, completed, deleted" })),
      assignee: Type.Optional(Type.String({ description: "Assign to agent, or empty string to unassign" })),
      deps_add: Type.Optional(Type.Array(Type.String(), { description: "Add these task IDs as dependencies" })),
      deps_remove: Type.Optional(Type.Array(Type.String(), { description: "Remove these task IDs from dependencies" })),
      result: Type.Optional(Type.String({ description: "Store result text on the task" })),
      filter: Type.Optional(Type.String({ description: "Filter for bulk ops: 'completed', 'pending', 'in_progress'" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Bulk operation
      if (params.task_id === "*") {
        const filter = params.filter ?? "";
        const updated = taskStore.updateWhere(filter, (t: any) => {
          if (params.status) t.status = params.status;
          if (params.assignee !== undefined) t.assignee = params.assignee || null;
          if (params.result) t.result = params.result;
          t.updatedAt = new Date().toISOString();
        });
        return { content: [textContent(`Bulk updated ${updated.length} tasks matching '${filter}'.`)], details: { updated: updated.length } };
      }

      // Single task
      const updated = taskStore.update(params.task_id, (t: any) => {
        if (params.status) t.status = params.status;
        if (params.assignee !== undefined) t.assignee = params.assignee || null;
        if (params.result) t.result = params.result;
        if (params.deps_add) {
          for (const dep of params.deps_add) {
            if (!t.blockedBy.includes(dep)) t.blockedBy.push(dep);
          }
        }
        if (params.deps_remove) {
          t.blockedBy = t.blockedBy.filter((d: string) => !params.deps_remove!.includes(d));
        }
        t.updatedAt = new Date().toISOString();
      });
      if (!updated) {
        return { content: [textContent(`Task ${params.task_id} not found.`)], details: { error: "not_found" } };
      }
      return { content: [textContent(`Task ${params.task_id} updated.`)], details: { task: updated } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_message")) pi.registerTool({
      name: "acp_message",
    label: "ACP Message",
    description: "Send or list messages. Consolidates acp_message_send and acp_message_list. Use action:'send' with kind:'dm'/'steer'/'broadcast', or action:'list'.",
    promptSnippet: "acp_message — send or list messages",
    parameters: Type.Object({
      action: Type.String({ description: "'send' or 'list'" }),
      to: Type.Optional(Type.String({ description: "Recipient agent name, or '*' for broadcast" })),
      message: Type.Optional(Type.String({ description: "Message text (for send)" })),
      kind: Type.Optional(Type.String({ description: "'dm', 'steer', 'broadcast'" })),
      from: Type.Optional(Type.String({ description: "Sender name" })),
      recipient: Type.Optional(Type.String({ description: "Recipient for list action" })),
      filter: Type.Optional(Type.String({ description: "Filter for list: 'unread'" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "send") {
        const kind: "dm" | "steer" | "broadcast" = params.to === "*" ? "broadcast" : ((params.kind as "dm" | "steer" | "broadcast" | undefined) ?? "dm");
        const result = mailboxManager.send({
          from: params.from ?? "user",
          to: params.to ?? "",
          message: params.message ?? "",
          kind,
        });
        return { content: [textContent(`Message sent to ${params.to} (${kind}).`)], details: { messageId: result.id } };
      }

      if (params.action === "list") {
        if (params.recipient) {
          const messages = mailboxManager.listFor(params.recipient);
          return { content: [textContent(`${messages.length} messages for ${params.recipient}.`)], details: { messages } };
        }
        // List all
        const messages = mailboxManager.listAll?.() ?? [];
        return { content: [textContent(`${messages.length} total messages.`)], details: { messages } };
      }

      return { content: [textContent(`Unknown action: ${params.action}. Use 'send' or 'list'.`)], details: { error: "unknown_action" } };
    },
  });

  // Lifecycle / management tools


  // Task layer tools
  if (isToolEnabled(toolSettings, "acp_task_create")) pi.registerTool({
      name: "acp_task_create",
    label: "ACP Task Create",
    description: "Create a persistent ACP task in the runtime task store.",
    promptSnippet: "acp_task_create — create ACP task",
    parameters: Type.Object({
      subject: Type.String({ description: "Short task subject" }),
      description: Type.Optional(Type.String({ description: "Longer task details" })),
      assignee: Type.Optional(Type.String({ description: "Optional agent assignee" })),
      deps: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on" })),
    }),
    async execute(_toolCallId, params) {
      const task = taskStore.create({ subject: params.subject, description: params.description, assignee: params.assignee, deps: params.deps });
      eventLog.append("task_create", { taskId: task.id, assignee: task.assignee });
      return { content: [textContent(formatJson(task))], details: task };
    },
  });


  // Messaging + governance + diagnostics


  function showAcpConfig(ctx: { ui: { notify: Function; setWidget: Function } }): void {
    config = loadConfig();
    const agents = Object.entries(config.agent_servers)
      .map(([name, cfg]) => `${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")}`)
      .join("\n");
    refreshWidget(ctx);
    ctx.ui.notify(
      `ACP Agent Servers Config\n${agents}\nDefault: ${config.defaultAgent ?? "none"}\nSessions: ${sessionMgr.size} | Circuit: ${cb.state}`,
      "info",
    );
  }

  function showAcpDoctor(ctx: { ui: { notify: Function; setWidget: Function } }): void {
    const payload = {
      configuredAgentServers: Object.keys(config.agent_servers),
      defaultAgent: config.defaultAgent,
      sessionCount: sessionMgr.size,
      runtimeDir: runtimePaths.rootDir,
      circuitBreaker: cb.state,
    };
    ctx.ui.notify(formatJson(payload), "info");
    refreshWidget(ctx);
  }

  const acpCommandGroups = {
    session: ["new", "load", "list", "shutdown", "kill", "prune", "set-model", "set-mode", "cancel"],
    prompt: [],
    delegate: [],
    broadcast: [],
    compare: [],
    task: ["create", "list", "get", "assign", "set-status", "dep-add", "dep-rm", "clear"],
    message: ["send", "list"],
    plan: ["request", "resolve"],
    runtime: ["status", "config", "env", "info", "event-log", "cleanup", "doctor"],
    settings: [],
  } as const;

  function renderAcpCommandSurface(): string {
    const lines = [
      "ACP command surface",
      "/acp session <new|load|list|shutdown|kill|prune|set-model|set-mode|cancel>",
      "/acp prompt",
      "/acp delegate",
      "/acp broadcast",
      "/acp compare",
      "/acp task <create|list|get|assign|set-status|dep-add|dep-rm|clear>",
      "/acp message <send|list>",
      "/acp plan <request|resolve>",
      "/acp runtime <status|config|env|info|event-log|cleanup|doctor>",
      "/acp settings — configure tool visibility",
      "Aliases: /acp-doctor, /acp-config",
    ];
    return lines.join("\n");
  }

  pi.registerCommand("acp", {
    description: "ACP root command: session, prompt, delegate, broadcast, compare, task, message, plan, runtime",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        ctx.ui.notify(renderAcpCommandSurface(), "info");
        refreshWidget(ctx);
        return;
      }

      const [group, subcommand] = tokens;
      const validGroup = Object.hasOwn(acpCommandGroups, group);
      if (!validGroup) {
        ctx.ui.notify(`${renderAcpCommandSurface()}\nUnknown group: ${group}`, "error");
        refreshWidget(ctx);
        return;
      }

      if (group === "settings") {
        await configureToolSettings(ctx as Parameters<typeof configureToolSettings>[0], ctx.cwd ?? process.cwd());
        return;
      }

      if (group === "runtime" && subcommand === "doctor") {
        showAcpDoctor(ctx);
        return;
      }
      if (group === "runtime" && subcommand === "config") {
        showAcpConfig(ctx);
        return;
      }

      const lines = [`Group: ${group}`];
      if (subcommand) lines.push(`Subcommand: ${subcommand}`);
      const supportedSubcommands = acpCommandGroups[group as keyof typeof acpCommandGroups];
      if (supportedSubcommands.length > 0) {
        lines.push(`Supported: ${supportedSubcommands.join(", ")}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("acp-config", {
    description: "Compatibility alias for /acp runtime config",
    async handler(_args, ctx) {
      showAcpConfig(ctx);
    },
  });

  pi.registerCommand("acp-doctor", {
    description: "Compatibility alias for /acp runtime doctor",
    async handler(_args, ctx) {
      showAcpDoctor(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    monitor.stop();
    await sessionMgr.disposeAll();
    for (const adapter of activeAdapters.values()) {
      adapter.dispose();
    }
    activeAdapters.clear();
    eventLog.append("session_shutdown_all");
  });
}

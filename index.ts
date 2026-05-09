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
  const widgetActivity = {
    activeDelegations: 0,
    activeBroadcasts: 0,
    activeCompares: 0,
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
    intervalMs: config.healthCheckIntervalMs ?? 30_000,
    staleTimeoutMs: config.staleTimeoutMs ?? 3_600_000,
    async onStale(sessionId: string) {
      const handle = sessionMgr.get(sessionId);
      if (!handle) return;
      const closeReason = getSessionAutoCloseReason(handle, config.staleTimeoutMs ?? 3_600_000);
      if (!closeReason) return;
      logger.info("session stale, disposing", { sessionId, closeReason });
      await closeSession(handle, closeReason, true);
      eventLog.append("session_stale", { sessionId, closeReason });
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
    defaultAgent: config.defaultAgent,
    activity: { ...widgetActivity },
  });

  const widgetFactory = createAcpWidget({ getState: getWidgetState });

  function ensureWidget(ctx: { ui: { setWidget: Function } }) {
    if (widgetRegistered) return;
    try {
      ctx.ui.setWidget("pi-acp-agents", widgetFactory);
      widgetRegistered = true;
    } catch {}
  }

  function refreshWidget(ctx: { ui: { setWidget: Function } }) {
    if (!widgetRegistered) {
      ensureWidget(ctx);
      return;
    }
    try {
      ctx.ui.setWidget("pi-acp-agents", widgetFactory);
    } catch {}
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

  function getAgentConfigOrThrow(agentName: string) {
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
          archiveSession(handle);
          try {
            const adapter = activeAdapters.get(target.sessionId)!;
            const promptResult = (await adapter.prompt(params.message)) as AcpPromptResult;
            markPromptLifecycle(handle, promptResult);
            eventLog.append("prompt_reused_session", { agentName, sessionId: target.sessionId, sessionName: handle.sessionName });
            return { ...promptResult, sessionId: target.sessionId, sessionName: handle.sessionName };
          } finally {
            busySessions.delete(target.sessionId);
            handle.busy = false;
            archiveSession(handle);
          }
        }

        if (target.sessionId && target.metadata) {
          throw new Error(`Session name "${target.sessionName ?? params.session_name}" refers to archived session "${target.sessionId}". Load it first with acp_session_load or use the raw session_id of a live session.`);
        }
        const agentCfg = getAgentConfigOrThrow(agentName);
        const adapter = createAdapter(agentName, agentCfg, config, params.cwd ?? ctx.cwd);
        try {
          await adapter.spawn();
          await adapter.initialize();
          const sessionId = await adapter.newSession(params.cwd ?? ctx.cwd);
          if (target.sessionName) {
            sessionNameStore.register(target.sessionName, sessionId);
          }
          const handle = makeSessionHandle(sessionId, agentName, params.cwd ?? ctx.cwd, adapter, undefined, target.sessionName);
          handle.busy = true;
          busySessions.set(sessionId, true);
          handle.lastActivityAt = new Date();
          archiveSession(handle);
          try {
            const promptResult = (await adapter.prompt(params.message)) as AcpPromptResult;
            markPromptLifecycle(handle, promptResult);
            eventLog.append("prompt_new_session", { agentName, sessionId, sessionName: handle.sessionName });
            return { ...promptResult, sessionId, sessionName: handle.sessionName };
          } finally {
            busySessions.delete(sessionId);
            handle.busy = false;
            archiveSession(handle);
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
          `ACP Agent Servers Status\n─────────────────\nCircuit Breaker: ${cb.state}\nAgent Servers: ${Object.keys(config.agent_servers).length} configured\nDefault: ${config.defaultAgent ?? "none"}\n\nAgent Servers:\n${agentLines || "  (none)"}\n\nActive Sessions (${sessionMgr.size}):\n${sessionLines || "  (none)"}`,
        )],
        details: { circuitBreaker: cb.state, agentCount: Object.keys(config.agent_servers).length, sessionCount: sessionMgr.size },
      };
    },
  });

  if (isToolEnabled(toolSettings, "acp_session_new")) pi.registerTool({
      name: "acp_session_new",
    label: "ACP New Session",
    description: "Create a new ACP agent session. Returns session ID for use with acp_prompt.",
    promptSnippet: "acp_session_new — create a new ACP session",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name. Default: configured default agent" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      session_id: Type.Optional(Type.String({ description: "Forbidden for new sessions; use acp_session_load to resume" })),
      session_name: Type.Optional(Type.String({ description: "Friendly immutable session name" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentName = getAgentName(params.agent);
      let sessionName: string | undefined;
      try {
        sessionName = normalizeOptionalSessionName(params.session_name);
      } catch (error) {
        return { content: [textContent(`Failed to create session: ${String((error as Error).message)}`)], details: { sessionId: "", sessionName: params.session_name, agent: agentName } };
      }
      if (params.session_id) {
        return { content: [textContent("acp_session_new does not accept caller-selected session IDs. Use acp_session_load to resume an existing session.")], details: { sessionId: "", agent: agentName, error: "session_id_not_allowed" } };
      }
      const result = await safeExecute(async () => {
        const agentCfg = getAgentConfigOrThrow(agentName);
        const adapter = createAdapter(agentName, agentCfg, config, params.cwd ?? ctx.cwd);
        try {
          await adapter.spawn();
          await adapter.initialize();
          const sessionId = await adapter.newSession(params.cwd ?? ctx.cwd);
          if (sessionName) {
            sessionNameStore.register(sessionName, sessionId);
          }
          makeSessionHandle(sessionId, agentName, params.cwd ?? ctx.cwd, adapter, undefined, sessionName);
          eventLog.append("session_new", { sessionId, agentName, sessionName });
          return sessionId;
        } catch (error) {
          adapter.dispose();
          throw error;
        }
      }, `acp_session_new(${agentName})`);

      refreshWidget(ctx);
      if (result.ok) {
        return { content: [textContent(`Created session ${result.value}${sessionName ? ` (${sessionName})` : ""} with agent \"${agentName}\"`)], details: { sessionId: result.value, sessionName, agent: agentName } };
      }
      return { content: [textContent(`Failed to create session: ${result.error}`)], details: { sessionId: "", sessionName: sessionName ?? params.session_name, agent: agentName } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_session_load")) pi.registerTool({
      name: "acp_session_load",
    label: "ACP Load Session",
    description: "Load an existing ACP agent session by ID to resume a conversation.",
    promptSnippet: "acp_session_load — load an existing ACP session",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session ID to load" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name to load" })),
      agent: Type.Optional(Type.String({ description: "Agent name from config" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let target;
      try {
        target = resolveSessionTarget(params);
      } catch (error) {
        return { content: [textContent(`Failed to load session: ${String((error as Error).message)}`)], details: {} };
      }
      const requestedSessionId = target.sessionId ?? requireString(params.session_name, "session_name");
      const archived = getArchivedSession(requestedSessionId);
      const requestedAgentName = params.agent ?? archived?.agentName ?? target.metadata?.agentName;
      const agentName = getAgentName(requestedAgentName);
      const result = await safeExecute(async () => {
        if (activeAdapters.has(requestedSessionId)) {
          const adapter = activeAdapters.get(requestedSessionId)!;
          await adapter.loadSession(requestedSessionId);
          const liveHandle = sessionMgr.get(requestedSessionId);
          if (liveHandle) {
            liveHandle.lastActivityAt = new Date();
            liveHandle.autoClosed = false;
            liveHandle.closeReason = undefined;
            archiveSession(liveHandle);
          }
          eventLog.append("session_load_reuse", { sessionId: requestedSessionId, agentName, sessionName: target.sessionName });
          return requestedSessionId;
        }
        const sessionMeta = getSessionMetadata(requestedSessionId) ?? target.metadata;
        const resolvedAgentName = params.agent ?? sessionMeta?.agentName ?? agentName;
        const resolvedCwd = params.cwd ?? sessionMeta?.cwd ?? ctx.cwd;
        const agentCfg = getAgentConfigOrThrow(resolvedAgentName);
        const adapter = createAdapter(resolvedAgentName, agentCfg, config, resolvedCwd);
        await adapter.spawn();
        await adapter.initialize();
        const sessionId = await adapter.loadSession(requestedSessionId);
        const handle = makeSessionHandle(sessionId, resolvedAgentName, resolvedCwd, adapter, sessionMeta, target.sessionName);
        if (sessionMeta?.model) {
          await adapter.setModel(sessionMeta.model);
          handle.model = sessionMeta.model;
        }
        if (sessionMeta?.mode) {
          await adapter.setMode(sessionMeta.mode);
          handle.mode = sessionMeta.mode;
        }
        handle.lastActivityAt = new Date();
        handle.autoClosed = false;
        handle.closeReason = undefined;
        archiveSession(handle);
        eventLog.append("session_load", { sessionId, agentName: resolvedAgentName, sessionName: handle.sessionName });
        return sessionId;
      }, `acp_session_load(${agentName})`);

      if (result.ok) {
        refreshWidget(ctx);
        return { content: [textContent(`Loaded session ${result.value}${target.sessionName ? ` (${target.sessionName})` : ""} with agent \"${agentName}\"`)], details: { sessionId: result.value, sessionName: target.sessionName, agent: agentName } };
      }
      return { content: [textContent(`Failed to load session: ${result.error}`)], details: {} };
    },
  });

  if (isToolEnabled(toolSettings, "acp_session_set_model")) pi.registerTool({
      name: "acp_session_set_model",
    label: "ACP Set Model",
    description: "Change the model for an active ACP agent session.",
    promptSnippet: "acp_session_set_model — change ACP session model",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session ID" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name" })),
      model_id: Type.String({ description: "Model ID (e.g., gemini-2.5-pro, gemini-2.5-flash)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = resolveSessionTarget(params);
      const handle = target.sessionId ? sessionMgr.get(target.sessionId) : undefined;
      if (!handle || handle.disposed) {
        return { content: [textContent(`Session \"${target.sessionName ?? target.sessionId ?? params.session_name ?? params.session_id}\" not found or disposed. Use acp_session_new or acp_prompt first.`)], details: { sessionId: target.sessionId, sessionName: target.sessionName, modelId: "", error: "not found or disposed" } };
      }
      const result = await safeExecute(async () => {
        const adapter = activeAdapters.get(handle.sessionId)!;
        await adapter.setModel(params.model_id);
        handle.model = params.model_id;
        handle.lastActivityAt = new Date();
        archiveSession(handle);
        eventLog.append("session_set_model", { sessionId: handle.sessionId, sessionName: handle.sessionName, modelId: params.model_id });
        return params.model_id;
      }, "acp_session_set_model");
      refreshWidget(ctx);
      if (result.ok) {
        return { content: [textContent(`Model set to \"${result.value}\" for session ${handle.sessionId}`)], details: { sessionId: handle.sessionId, sessionName: handle.sessionName, modelId: result.value } };
      }
      return { content: [textContent(`Failed to set model: ${result.error}`)], details: {} };
    },
  });

  if (isToolEnabled(toolSettings, "acp_session_set_mode")) pi.registerTool({
      name: "acp_session_set_mode",
    label: "ACP Set Mode",
    description: "Change the agent session mode for an active ACP agent session.",
    promptSnippet: "acp_session_set_mode — change ACP session mode",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session ID" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name" })),
      mode_id: Type.String({ description: "Mode ID (e.g., default, autoEdit, yolo, plan)" }),
    }),
    async execute(_toolCallId, params) {
      const target = resolveSessionTarget(params);
      const handle = target.sessionId ? sessionMgr.get(target.sessionId) : undefined;
      if (!handle || handle.disposed) {
        return { content: [textContent(`Session \"${target.sessionName ?? target.sessionId ?? params.session_name ?? params.session_id}\" not found or disposed. Use acp_session_new or acp_prompt first.`)], details: { sessionId: target.sessionId, sessionName: target.sessionName, modeId: "", error: "not found or disposed" } };
      }
      const result = await safeExecute(async () => {
        const adapter = activeAdapters.get(handle.sessionId)!;
        await adapter.setMode(params.mode_id);
        handle.mode = params.mode_id;
        handle.lastActivityAt = new Date();
        archiveSession(handle);
        eventLog.append("session_set_mode", { sessionId: handle.sessionId, sessionName: handle.sessionName, modeId: params.mode_id });
        return params.mode_id;
      }, "acp_session_set_mode");
      if (result.ok) {
        return { content: [textContent(`Mode set to \"${result.value}\" for session ${handle.sessionId}`)], details: { sessionId: handle.sessionId, sessionName: handle.sessionName, modeId: result.value, error: "" } };
      }
      return { content: [textContent(`Failed to set mode: ${result.error}`)], details: { sessionId: handle.sessionId, sessionName: handle.sessionName, modeId: "", error: result.error } };
    },
  });

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
  if (isToolEnabled(toolSettings, "acp_delegate")) pi.registerTool({
      name: "acp_delegate",
    label: "ACP Delegate",
    description: "Delegate a task to a specific ACP agent and get its response. Creates a short-lived session that is disposed after use.",
    promptSnippet: "acp_delegate — delegate a task to an ACP agent",
    parameters: Type.Object({
      message: Type.String({ description: "Task to delegate to the agent" }),
      agent: Type.Optional(Type.String({ description: "Agent name from config. Default: use defaultAgent" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentName = getAgentName(params.agent);
      if (!config.agent_servers[agentName]) {
        return { content: [textContent(`Agent \"${agentName}\" not found. Available: ${Object.keys(config.agent_servers).join(", ") || "none"}`)], details: { agent: agentName, error: "not found" } };
      }
      const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd);
      beginWidgetActivity("delegate", ctx);
      const result = await safeExecute(async () => {
        const r = await coordinator.delegate(agentName, params.message, params.cwd ?? ctx.cwd);
        if (r.stopReason === "error" && !r.text) {
          throw new Error(`Agent returned stopReason=error with no text. Session: ${r.sessionId}`);
        }
        eventLog.append("delegate", { agentName, cwd: params.cwd ?? ctx.cwd });
        return r;
      }, `acp_delegate(${agentName})`, { timeoutMs: config.toolTimeouts?.delegate ?? config.stallTimeoutMs });

      if (result.ok) {
        endWidgetActivity("delegate", ctx);
        return { content: [textContent(result.value.text || "(no response)")], details: { agent: agentName, sessionId: result.value.sessionId, stopReason: result.value.stopReason } };
      }
      endWidgetActivity("delegate", ctx, result.error);
      return {
        content: [textContent(`Delegate failed (${agentName}):\n  Error: ${result.error}\n  Circuit open: ${result.circuitOpen ? "yes" : "no"}\n  Agent config: command=${config.agent_servers[agentName]?.command} args=${(config.agent_servers[agentName]?.args ?? []).join(" ")}`)],
        details: { agent: agentName, error: result.error, circuitOpen: result.circuitOpen },
      };
    },
  });

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
      const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd);
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

  if (isToolEnabled(toolSettings, "acp_compare")) pi.registerTool({
      name: "acp_compare",
    label: "ACP Compare",
    description: "Get responses from multiple ACP agents and compare them. Returns a structured comparison of all responses.",
    promptSnippet: "acp_compare — compare responses from multiple ACP agents",
    parameters: Type.Object({
      message: Type.String({ description: "Prompt to compare across agents" }),
      agents: Type.Optional(Type.Array(Type.String(), { description: "Agent names. Default: all configured agents" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentNames = params.agents ?? Object.keys(config.agent_servers);
      if (agentNames.length === 0) {
        return { content: [textContent("No agent servers configured or specified.")], details: { comparison: null, error: "no agents" } };
      }
      const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd);
      beginWidgetActivity("compare", ctx);
      const result = await safeExecute(async () => {
        const output = await coordinator.compare(agentNames, params.message, params.cwd ?? ctx.cwd);
        eventLog.append("compare", { agentNames, cwd: params.cwd ?? ctx.cwd });
        return output;
      }, `acp_compare(${agentNames.join(",")})`, { timeoutMs: config.toolTimeouts?.compare ?? config.stallTimeoutMs });
      if (!result.ok) {
        endWidgetActivity("compare", ctx, result.error);
        return { content: [textContent(`Compare failed: ${result.error}`)], details: { comparison: null, error: result.error, circuitOpen: result.circuitOpen } };
      }
      const lines = result.value.responses.map((r) => r.error ? `| ${r.agent.padEnd(20)} | ERROR: ${r.error}`.padEnd(104) + " |" : `| ${r.agent.padEnd(20)} | ${r.text.substring(0, 200).padEnd(80)} |`);
      const table = `Comparison: \"${params.message}\"\nTimestamp: ${result.value.timestamp}\n\n| Agent                | Response                                                                              |\n|${"-".repeat(22)}|${"-".repeat(84)}|\n${lines.join("\n")}`;
      endWidgetActivity("compare", ctx);
      return { content: [textContent(table)], details: { comparison: result.value } };
    },
  });

  // Lifecycle / management tools
  if (isToolEnabled(toolSettings, "acp_session_list")) pi.registerTool({
      name: "acp_session_list",
    label: "ACP Session List",
    description: "List active ACP sessions with agent, cwd, busy state, and plan state.",
    promptSnippet: "acp_session_list — list active ACP sessions",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Optional agent filter" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessions = sessionMgr.listByAgent(params.agent).map((session) => ({
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        agent: session.agentName,
        cwd: session.cwd,
        model: session.model,
        busy: busySessions.get(session.sessionId) ?? false,
        planStatus: session.planStatus ?? "none",
        lastActivityAt: session.lastActivityAt.toISOString(),
      }));
      refreshWidget(ctx);
      return { content: [textContent(formatJson({ sessions }))], details: { sessions } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_session_shutdown")) pi.registerTool({
      name: "acp_session_shutdown",
    label: "ACP Session Shutdown",
    description: "Gracefully dispose a specific ACP session, or all sessions for an agent.",
    promptSnippet: "acp_session_shutdown — gracefully shut down ACP sessions",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Specific session ID" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name" })),
      agent: Type.Optional(Type.String({ description: "Agent name to shut down all sessions for" })),
      all: Type.Optional(Type.Boolean({ description: "Shutdown all active sessions" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await safeExecute(async () => {
        const target = resolveSessionTarget(params);
        const targets = params.all
          ? sessionMgr.list()
          : target.sessionId
            ? sessionMgr.get(target.sessionId)
              ? [sessionMgr.get(target.sessionId)!]
              : []
            : params.agent
              ? sessionMgr.listByAgent(params.agent)
              : [];
        if (targets.length === 0) throw new Error("No matching sessions found for shutdown");
        for (const target of targets) {
          await closeSession(target, "manual-shutdown");
          eventLog.append("session_shutdown", { sessionId: target.sessionId, agent: target.agentName });
        }
        return targets.map((target) => target.sessionId);
      }, "acp_session_shutdown");
      refreshWidget(ctx);
      if (result.ok) {
        return { content: [textContent(`Shutdown sessions: ${result.value.join(", ")}`)], details: { sessionIds: result.value } };
      }
      return { content: [textContent(`Shutdown failed: ${result.error}`)], details: { sessionIds: [] } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_session_kill")) pi.registerTool({
      name: "acp_session_kill",
    label: "ACP Session Kill",
    description: "Force-kill a specific ACP session and remove it from runtime state.",
    promptSnippet: "acp_session_kill — force kill ACP session",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session ID to kill" })),
      session_name: Type.Optional(Type.String({ description: "Friendly session name to kill" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await safeExecute(async () => {
        const target = resolveSessionTarget(params);
        const handle = target.sessionId ? sessionMgr.get(target.sessionId) : undefined;
        if (!handle) throw new Error(`Session \"${target.sessionName ?? target.sessionId ?? params.session_name ?? params.session_id}\" not found`);
        handle.disposed = true;
        await closeSession(handle, "manual-kill");
        eventLog.append("session_kill", { sessionId: handle.sessionId, sessionName: handle.sessionName, agent: handle.agentName });
        return handle.sessionId;
      }, "acp_session_kill");
      refreshWidget(ctx);
      if (result.ok) {
        return { content: [textContent(`Killed session ${result.value}`)], details: { sessionId: result.value, sessionName: sessionNameStore.getName(result.value) } };
      }
      return { content: [textContent(`Kill failed: ${result.error}`)], details: {} };
    },
  });

  if (isToolEnabled(toolSettings, "acp_prune")) pi.registerTool({
      name: "acp_prune",
    label: "ACP Prune",
    description: "Prune stale or disposed ACP sessions from runtime state.",
    promptSnippet: "acp_prune — prune stale ACP sessions",
    parameters: Type.Object({
      stale_after_ms: Type.Optional(Type.Number({ description: "Idle threshold in milliseconds" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threshold = params.stale_after_ms ?? config.staleTimeoutMs ?? 3_600_000;
      const result = await safeExecute(async () => {
        const targets = sessionMgr.list().filter((session) => session.disposed || !!getSessionAutoCloseReason(session, threshold));
        for (const target of targets) {
          await closeSession(target, target.disposed ? "disposed" : getSessionAutoCloseReason(target, threshold)!);
        }
        const removedSessionIds = targets.map((target) => target.sessionId);
        eventLog.append("session_prune", { threshold, removedSessionIds });
        return removedSessionIds;
      }, "acp_prune");
      refreshWidget(ctx);
      if (result.ok) {
        return { content: [textContent(`Pruned sessions: ${result.value.join(", ") || "(none)"}`)], details: { sessionIds: result.value } };
      }
      return { content: [textContent(`Prune failed: ${result.error}`)], details: { sessionIds: [] } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_runtime_info")) pi.registerTool({
      name: "acp_runtime_info",
    label: "ACP Runtime Info",
    description: "Show ACP runtime id/path information, configured agents, and runtime storage files.",
    promptSnippet: "acp_runtime_info — show ACP runtime info",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const info = {
        runtimeDir: runtimePaths.rootDir,
        tasksFile: runtimePaths.tasksFile,
        mailboxesFile: runtimePaths.mailboxesFile,
        governanceFile: runtimePaths.governanceFile,
        eventLogFile: runtimePaths.eventLogFile,
        sessionArchiveFile: runtimePaths.sessionArchiveFile,
        sessionNameRegistryFile: runtimePaths.sessionNameRegistryFile,
        sessionCount: sessionMgr.size,
        configuredAgentServers: Object.keys(config.agent_servers),
      };
      return { content: [textContent(formatJson(info))], details: info };
    },
  });

  if (isToolEnabled(toolSettings, "acp_env")) pi.registerTool({
      name: "acp_env",
    label: "ACP Env",
    description: "Show environment and command details for manually spawning a configured ACP agent.",
    promptSnippet: "acp_env — show ACP agent spawn env",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name" })),
    }),
    async execute(_toolCallId, params) {
      const agentName = getAgentName(params.agent);
      try {
        const agent = getAgentConfigOrThrow(agentName);
        const payload = {
          agent: agentName,
          command: agent.command,
          args: agent.args ?? [],
          cwd: agent.cwd,
          env: agent.env ?? {},
        };
        return { content: [textContent(formatJson(payload))], details: payload };
      } catch (error) {
        return { content: [textContent(String((error as Error).message))], details: { agent: agentName, command: "", args: [], cwd: undefined, env: {} } };
      }
    },
  });

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
    }),
    async execute(_toolCallId, params) {
      const task = taskStore.create({ subject: params.subject, description: params.description, assignee: params.assignee });
      eventLog.append("task_create", { taskId: task.id, assignee: task.assignee });
      return { content: [textContent(formatJson(task))], details: task };
    },
  });

  if (isToolEnabled(toolSettings, "acp_task_list")) pi.registerTool({
      name: "acp_task_list",
    label: "ACP Task List",
    description: "List ACP tasks, optionally filtered by status.",
    promptSnippet: "acp_task_list — list ACP tasks",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Optional status filter" })),
      include_deleted: Type.Optional(Type.Boolean({ description: "Include deleted tasks" })),
    }),
    async execute(_toolCallId, params) {
      const tasks = taskStore.list({ status: params.status as AcpTaskStatus | undefined, includeDeleted: params.include_deleted });
      return { content: [textContent(formatJson({ tasks }))], details: { tasks } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_task_get")) pi.registerTool({
      name: "acp_task_get",
    label: "ACP Task Get",
    description: "Show one ACP task including dependency state.",
    promptSnippet: "acp_task_get — show ACP task",
    parameters: Type.Object({ task_id: Type.String({ description: "Task ID" }) }),
    async execute(_toolCallId, params) {
      const task = taskStore.get(params.task_id);
      if (!task) return { content: [textContent(`Task \"${params.task_id}\" not found`)], details: { id: params.task_id, subject: "", status: "pending" as AcpTaskStatus, blockedBy: [], createdAt: "", updatedAt: "" } };
      return { content: [textContent(formatJson(task))], details: task };
    },
  });

  if (isToolEnabled(toolSettings, "acp_task_assign")) pi.registerTool({
      name: "acp_task_assign",
    label: "ACP Task Assign",
    description: "Assign or unassign an ACP task.",
    promptSnippet: "acp_task_assign — assign ACP task",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID" }),
      assignee: Type.Optional(Type.String({ description: "Assignee name; omit to clear" })),
    }),
    async execute(_toolCallId, params) {
      const task = taskStore.update(params.task_id, (record) => {
        record.assignee = params.assignee;
      });
      eventLog.append("task_assign", { taskId: task.id, assignee: task.assignee ?? null });
      return { content: [textContent(formatJson(task))], details: task };
    },
  });

  if (isToolEnabled(toolSettings, "acp_task_set_status")) pi.registerTool({
      name: "acp_task_set_status",
    label: "ACP Task Set Status",
    description: "Set ACP task status transitions (pending, in_progress, completed, deleted).",
    promptSnippet: "acp_task_set_status — update ACP task status",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID" }),
      status: Type.String({ description: "New status" }),
      result: Type.Optional(Type.String({ description: "Optional task result text" })),
    }),
    async execute(_toolCallId, params) {
      const task = taskStore.update(params.task_id, (record) => {
        record.status = params.status as AcpTaskStatus;
        if (params.result !== undefined) record.result = params.result;
      });
      eventLog.append("task_status", { taskId: task.id, status: task.status });
      return { content: [textContent(formatJson(task))], details: task };
    },
  });

  if (isToolEnabled(toolSettings, "acp_task_dependency_add")) pi.registerTool({
      name: "acp_task_dependency_add",
    label: "ACP Task Dependency Add",
    description: "Add a blocking dependency to an ACP task.",
    promptSnippet: "acp_task_dependency_add — add ACP task dependency",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID" }),
      dependency_id: Type.String({ description: "Dependency task ID" }),
    }),
    async execute(_toolCallId, params) {
      const task = taskStore.update(params.task_id, (record) => {
        if (!record.blockedBy.includes(params.dependency_id)) record.blockedBy.push(params.dependency_id);
      });
      eventLog.append("task_dependency_add", { taskId: task.id, dependencyId: params.dependency_id });
      return { content: [textContent(formatJson(task))], details: task };
    },
  });

  if (isToolEnabled(toolSettings, "acp_task_dependency_remove")) pi.registerTool({
      name: "acp_task_dependency_remove",
    label: "ACP Task Dependency Remove",
    description: "Remove a blocking dependency from an ACP task.",
    promptSnippet: "acp_task_dependency_remove — remove ACP task dependency",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID" }),
      dependency_id: Type.String({ description: "Dependency task ID" }),
    }),
    async execute(_toolCallId, params) {
      const task = taskStore.update(params.task_id, (record) => {
        record.blockedBy = record.blockedBy.filter((item) => item !== params.dependency_id);
      });
      eventLog.append("task_dependency_remove", { taskId: task.id, dependencyId: params.dependency_id });
      return { content: [textContent(formatJson(task))], details: task };
    },
  });

  if (isToolEnabled(toolSettings, "acp_task_clear")) pi.registerTool({
      name: "acp_task_clear",
    label: "ACP Task Clear",
    description: "Clear completed tasks or wipe the entire ACP task store.",
    promptSnippet: "acp_task_clear — clear ACP tasks",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "completed or all" })),
    }),
    async execute(_toolCallId, params) {
      const result = taskStore.clear((params.mode as "completed" | "all" | undefined) ?? "completed");
      eventLog.append("task_clear", result);
      return { content: [textContent(formatJson(result))], details: result };
    },
  });

  // Messaging + governance + diagnostics
  if (isToolEnabled(toolSettings, "acp_message_send")) pi.registerTool({
      name: "acp_message_send",
    label: "ACP Message Send",
    description: "Send a persistent mailbox message or steer message to an ACP agent.",
    promptSnippet: "acp_message_send — send ACP mailbox message",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent or * for broadcast" }),
      message: Type.String({ description: "Message body" }),
      kind: Type.Optional(Type.String({ description: "dm, steer, or broadcast" })),
      from: Type.Optional(Type.String({ description: "Sender identity" })),
    }),
    async execute(_toolCallId, params) {
      const mail = mailboxManager.send({
        from: params.from ?? "leader",
        to: params.to,
        message: params.message,
        kind: (params.kind as "dm" | "steer" | "broadcast" | undefined) ?? (params.to === "*" ? "broadcast" : "dm"),
      });
      eventLog.append("mail_send", { to: mail.to, kind: mail.kind, messageId: mail.id });
      return { content: [textContent(formatJson(mail))], details: mail };
    },
  });

  if (isToolEnabled(toolSettings, "acp_message_list")) pi.registerTool({
      name: "acp_message_list",
    label: "ACP Message List",
    description: "List mailbox messages for an ACP agent.",
    promptSnippet: "acp_message_list — list ACP mailbox messages",
    parameters: Type.Object({ recipient: Type.String({ description: "Recipient agent name" }) }),
    async execute(_toolCallId, params) {
      const messages = mailboxManager.listFor(params.recipient);
      return { content: [textContent(formatJson({ messages }))], details: { messages } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_plan_request")) pi.registerTool({
      name: "acp_plan_request",
    label: "ACP Plan Request",
    description: "Mark an ACP agent as waiting for plan approval.",
    promptSnippet: "acp_plan_request — request ACP plan approval",
    parameters: Type.Object({ agent: Type.String({ description: "Agent name" }) }),
    async execute(_toolCallId, params) {
      const plan = governanceStore.requestPlan(params.agent);
      for (const session of sessionMgr.listByAgent(params.agent)) session.planStatus = "pending";
      eventLog.append("plan_request", { agent: params.agent });
      return { content: [textContent(formatJson(plan))], details: plan };
    },
  });

  if (isToolEnabled(toolSettings, "acp_plan_resolve")) pi.registerTool({
      name: "acp_plan_resolve",
    label: "ACP Plan Resolve",
    description: "Approve or reject a pending ACP plan request.",
    promptSnippet: "acp_plan_resolve — approve or reject ACP plan",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
      action: Type.String({ description: "approved or rejected" }),
      feedback: Type.Optional(Type.String({ description: "Optional rejection feedback" })),
    }),
    async execute(_toolCallId, params) {
      const normalized = params.action === "approved" ? "approved" : params.action === "rejected" ? "rejected" : undefined;
      if (!normalized) {
        return { content: [textContent("action must be approved or rejected")], details: { agent: params.agent, status: "pending" as const, requestedAt: new Date().toISOString() } };
      }
      const plan = governanceStore.resolvePlan(params.agent, normalized, params.feedback);
      for (const session of sessionMgr.listByAgent(params.agent)) session.planStatus = normalized;
      eventLog.append("plan_resolve", { agent: params.agent, status: normalized });
      return { content: [textContent(formatJson(plan))], details: plan };
    },
  });

  if (isToolEnabled(toolSettings, "acp_model_policy_get")) pi.registerTool({
      name: "acp_model_policy_get",
    label: "ACP Model Policy Get",
    description: "Inspect ACP model policy constraints and current default behavior.",
    promptSnippet: "acp_model_policy_get — inspect ACP model policy",
    parameters: Type.Object({}),
    async execute() {
      const policy = governanceStore.getModelPolicy();
      return { content: [textContent(formatJson(policy))], details: policy };
    },
  });

  if (isToolEnabled(toolSettings, "acp_model_policy_check")) pi.registerTool({
      name: "acp_model_policy_check",
    label: "ACP Model Policy Check",
    description: "Validate a model override against ACP governance rules.",
    promptSnippet: "acp_model_policy_check — validate ACP model policy",
    parameters: Type.Object({
      model: Type.Optional(Type.String({ description: "Model override to validate" })),
    }),
    async execute(_toolCallId, params) {
      const result = governanceStore.checkModel(params.model);
      return { content: [textContent(formatJson(result))], details: result };
    },
  });

  if (isToolEnabled(toolSettings, "acp_doctor")) pi.registerTool({
      name: "acp_doctor",
    label: "ACP Doctor",
    description: "Run ACP diagnostics covering config, runtime paths, sessions, and policy state.",
    promptSnippet: "acp_doctor — run ACP diagnostics",
    parameters: Type.Object({}),
    async execute() {
      const payload = {
        configuredAgentServers: Object.keys(config.agent_servers),
        defaultAgent: config.defaultAgent,
        sessionCount: sessionMgr.size,
        runtime: runtimePaths,
        circuitBreaker: cb.state,
        modelPolicy: governanceStore.getModelPolicy(),
        taskCount: taskStore.list({ includeDeleted: true }).length,
      };
      eventLog.append("doctor", { sessionCount: payload.sessionCount, taskCount: payload.taskCount });
      return { content: [textContent(formatJson(payload))], details: payload };
    },
  });

  if (isToolEnabled(toolSettings, "acp_event_log")) pi.registerTool({
      name: "acp_event_log",
    label: "ACP Event Log",
    description: "Return the ACP structured event log file path for inspection.",
    promptSnippet: "acp_event_log — show ACP event log path",
    parameters: Type.Object({}),
    async execute() {
      return { content: [textContent(runtimePaths.eventLogFile)], details: { path: runtimePaths.eventLogFile } };
    },
  });

  if (isToolEnabled(toolSettings, "acp_cleanup")) pi.registerTool({
      name: "acp_cleanup",
    label: "ACP Cleanup",
    description: "Clean up ACP runtime state: sessions, tasks, or mailbox contents.",
    promptSnippet: "acp_cleanup — cleanup ACP runtime state",
    parameters: Type.Object({
      target: Type.String({ description: "sessions, tasks, mailboxes, or all" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await safeExecute(async () => {
        if (params.target === "sessions" || params.target === "all") {
          for (const session of sessionMgr.list()) {
            await closeSession(session, "cleanup");
          }
          activeAdapters.clear();
          busySessions.clear();
        }
        if (params.target === "tasks" || params.target === "all") {
          taskStore.clear("all");
        }
        if (params.target === "mailboxes" || params.target === "all") {
          for (const agent of Object.keys(config.agent_servers)) mailboxManager.clearFor(agent);
          mailboxManager.clearFor("*");
        }
        eventLog.append("cleanup", { target: params.target });
        return { target: params.target, ok: true };
      }, "acp_cleanup");
      refreshWidget(ctx);
      if (result.ok) {
        return { content: [textContent(formatJson(result.value))], details: result.value };
      }
      return { content: [textContent(`Cleanup failed: ${result.error}`)], details: { ok: false } };
    },
  });

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
        await configureToolSettings(ctx as any, ctx.cwd ?? process.cwd());
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

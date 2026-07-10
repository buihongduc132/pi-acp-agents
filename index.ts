import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { type AcpWidgetState, type AcpWidgetDag, dagIndexEntryToWidgetDag } from "./src/acp-widget.js";
import { createAcpPanel, type AcpPanelTask } from "./src/tui/acp-panel.js";
import { buildAcpPanelDepsReadOnly } from "./src/tui/panel-deps.js";
import { buildAcpPanelDepsFull } from "./src/tui/panel-deps-full.js";
import { resolvePersona } from "./src/tui/persona-resolver.js";
import type { AcpTaskRecord } from "./src/management/task-store.js";
import { createAdapter } from "./src/adapter-factory.js";
import { loadConfig } from "./src/config/config.js";
import type { AcpArchivedSessionMetadata, AcpConfig, AcpPromptResult, AcpSessionHandle, AcpWorkerStatus, DagIndexEntry } from "./src/config/types.js";
import { AgentCoordinator } from "./src/coordination/coordinator.js";
import { WorkerDispatcher, type WorkerDispatcherDeps } from "./src/coordination/worker-dispatcher.js";
import { AcpCircuitBreaker } from "./src/core/circuit-breaker.js";
import { AsyncExecutor } from "./src/core/async-executor.js";
import { HealthMonitor } from "./src/core/health-monitor.js";
import { getSessionAutoCloseReason } from "./src/core/session-lifecycle.js";
import { SessionManager } from "./src/core/session-manager.js";
import { createFileLogger } from "./src/logger.js";
import { AcpEventLog } from "./src/management/event-log.js";
import { GovernanceStore } from "./src/management/governance-store.js";
import { consumeHeartbeat } from "./src/management/heartbeat-parser.js";
import { MailboxManager } from "./src/management/mailbox-manager.js";
import { AcpTaskStore, type AcpTaskStatus } from "./src/management/task-store.js";
import { WorkerStore } from "./src/management/worker-store.js";
import { SessionArchiveStore } from "./src/management/session-archive-store.js";
import { SessionNameStore } from "./src/management/session-name-store.js";
import { SessionStoreFactory } from "./src/management/session-store-factory.js";
import { ensureRuntimeDir } from "./src/management/runtime-paths.js";
import { DagStore } from "./src/dag/dag-store.js";
import { DagValidator } from "./src/dag/dag-validator.js";
import { DagExecutor, type DagCancelSummary } from "./src/dag/dag-executor.js";
import { TemplateResolver } from "./src/dag/template-resolver.js";
import { loadSettings, isToolEnabled, type AcpToolSettings } from "./src/settings/config.js";
import { configureToolSettings } from "./src/settings/configure-tui.js";
import { HookDispatcher } from "./src/hooks/dispatcher.js";
import { FailurePolicyEngine } from "./src/hooks/policy.js";
import { HookTriggerManager } from "./src/hooks/trigger-wiring.js";
import { SocketPublisher } from "./src/hooks/socket-bus.js";
import { WakeSubscriber } from "./src/hooks/wake-subscriber.js";
import { loadHookConfig } from "./src/hooks/config.js";
import { registerHooksPolicyTools, type PolicyStore } from "./src/hooks/policy-tools.js";
import { NonBlockingRunner } from "./src/hooks/non-blocking.js";
import { defaultHooksDir } from "./src/hooks/types.js";

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
  const workerSessionMap = new Map<string, string>(); // sessionId → workerName for heartbeat consumer
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

  // ── ACP Hooks infrastructure (LD1-LD18) ──
  // Skip ALL hooks init in test mode to avoid timers/sockets keeping the
  // event loop alive across 180+ test files (causes 5s timeouts in full suite).
  // Tests exercise hooks modules directly via test/hooks/*.test.ts.
  const hookConfig = loadHookConfig();
  const hooksDir = defaultHooksDir();
  const hooksDisabled = process.env.VITEST === "true" || !hookConfig.enabled;

  // No-op stubs used when hooks are disabled (tests / disabled via config).
  const noopHookRunner = {
    runFireAndForget(_label: string, fn: () => Promise<unknown> | unknown): void {
      try { void Promise.resolve(fn()).catch(() => {}); } catch { /* isolated */ }
    },
    dispose(): void { /* noop */ },
  };
  const noopHookTriggers = {
    onSessionAdded(_h: unknown): Promise<void> { return Promise.resolve(); },
    onSessionRemoved(_h: unknown, _err?: unknown): Promise<void> { return Promise.resolve(); },
    onSessionIdle(_s: unknown): Promise<void> { return Promise.resolve(); },
    onTaskDispatched(_t: unknown): Promise<void> { return Promise.resolve(); },
    onTaskResult(_t: unknown): Promise<void> { return Promise.resolve(); },
    onSubagentStart(_s: unknown): Promise<void> { return Promise.resolve(); },
    onSubagentStop(_s: unknown): Promise<void> { return Promise.resolve(); },
    onSpawnCompleted(_s: unknown): Promise<void> { return Promise.resolve(); },
    dispose(): void { /* noop */ },
  };

  // Publisher is created async after socket bind; use a ref so the
  // dispatcher's delegate always reads the live value.
  const hookPublisherRef: { current: SocketPublisher | null } = { current: null };
  let hookWake: WakeSubscriber | null = null;
  let hookDispatcher: HookDispatcher;
  let hookRunner: NonBlockingRunner | typeof noopHookRunner;
  let hookTriggers: HookTriggerManager | typeof noopHookTriggers;

  if (!hooksDisabled) {
    // Failure policy engine — wired to the dispatcher for phase 3 aggregation
    const failurePolicyEngine = new FailurePolicyEngine({
      failureAction: hookConfig.failureAction,
      maxReopensPerTask: hookConfig.maxReopensPerTask,
      followupOwner: hookConfig.followupOwner,
    });
    hookDispatcher = new HookDispatcher({
      config: hookConfig,
      hooksDir,
      enableReentrancyGuard: true,
      publisher: {
        publish(event) {
          const pub = hookPublisherRef.current;
          if (!pub) return false;
          return pub.publish(event);
        },
      },
      applyFailurePolicy: async (action, context) => {
        if (!context.task) return { handled: true, action };
        const policyTask = {
          id: context.task.id,
          subject: context.task.subject,
          status: context.task.status,
          metadata: {
            qualityGateFailureCount: 0,
            reopenedByQualityGateCount: 0,
          },
        };
        const result = await failurePolicyEngine.applyFailurePolicy(
          action,
          policyTask,
          context,
          { warn: (...args: unknown[]) => logger.warn(String(args[0] ?? "")), info: (...args: unknown[]) => logger.info(String(args[0] ?? "")) },
        );
        return { handled: result.handled, action: result.action };
      },
    });
    hookRunner = new NonBlockingRunner({ logger: console });
    hookTriggers = new HookTriggerManager({
      hookDispatcher: hookDispatcher,
      defaultCwd: homedir(),
    });
    // Fire-and-forget socket bus init — never block startup
    void (async () => {
      try {
        if (hookConfig.socket.enabled) {
          const pub = new SocketPublisher({ path: hookConfig.socket.path });
          await pub.start();
          hookPublisherRef.current = pub;
        }
        hookWake = new WakeSubscriber({
          path: hookConfig.socket.path,
          pi: {
            sendUserMessage: (msg: string, opts?: { deliverAs?: string }) =>
              pi.sendUserMessage(msg, { deliverAs: opts?.deliverAs as "steer" | "followUp" | undefined }),
            log: (...args: unknown[]) => logger.info(String(args[0] ?? "")),
          },
        });
        await hookWake.start();
      } catch (err) {
        logger.error("[acp-hooks] socket bus init failed", { error: String(err) });
      }
    })();
  } else {
    // Disabled / test mode — create a real dispatcher (no timers) but no-op runner/triggers
    hookDispatcher = new HookDispatcher({ config: hookConfig, hooksDir, publisher: { publish: () => false } });
    hookRunner = noopHookRunner;
    hookTriggers = noopHookTriggers;
  }
  // Policy store — in-memory, seeded from loaded config
  const hookPolicyStore: PolicyStore = (() => {
    const store = new Map<string, unknown>();
    store.set("failureAction", hookConfig.failureAction);
    store.set("maxReopensPerTask", hookConfig.maxReopensPerTask);
    store.set("followupOwner", hookConfig.followupOwner);
    return {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => { store.set(key, value); },
      delete: (key: string) => { store.delete(key); },
    };
  })();
  const runtimePaths = ensureRuntimeDir(config.runtimeDir);
  const eventLog = new AcpEventLog(runtimePaths.rootDir);
  const sessionNameStore = new SessionNameStore(runtimePaths.rootDir);

  // Session-scoped stores — lazily created per host session ID
  const storeFactory = new SessionStoreFactory(runtimePaths.rootDir);
  let hostSessionId: string | undefined;

  // Capture host session ID on session start (fires before any tool call)
  pi.on("session_start", (_event, ctx) => {
    hostSessionId = ctx.sessionManager.getSessionId();
    // Apply governance policy to the session-scoped governance store
    storeFactory.get(hostSessionId).governanceStore.setModelPolicy(config.modelPolicy ?? {});
  });

  /** Get session-scoped stores for the current host session. */
  function getStores() {
    const sid = hostSessionId ?? process.env.PI_SESSION_ID ?? "default";
    return storeFactory.get(sid);
  }

  /** Convenience accessors for closures that need stores without ctx. */
  const taskStore = () => getStores().taskStore;
  const workerStore = () => getStores().workerStore;
  const mailboxManager = () => getStores().mailboxManager;
  const governanceStore = () => getStores().governanceStore;

  /** Defensive worker lookup — returns undefined if the store or .get() is unavailable (e.g. partial test mocks). */
  function safeWorkerGet(name: string) {
    try {
      const ws = workerStore();
      if (ws && typeof ws.get === "function") return ws.get(name);
    } catch { /* store unavailable */ }
    return undefined;
  }

  // SessionArchiveStore is GLOBAL (catalogs all sessions) — not session-scoped
  const sessionArchiveStore = new SessionArchiveStore(runtimePaths.rootDir);

  const cb = new AcpCircuitBreaker(
    config.circuitBreakerMaxFailures ?? 3,
    config.circuitBreakerResetMs ?? 60_000,
    config.stallTimeoutMs ?? 300_000,
  );

  // DAG orchestration — file-backed store, validator, template resolver, and
  // wave-based executor. Wired with existing infrastructure singletons below.
  // The coordinator and async executor are created lazily per tool call where
  // they already exist; the DagExecutor consults the coordinator on each step
  // dispatch, so a placeholder is passed and the real coordinator is supplied
  // at execute time inside acp_dag_submit.
  //
  // Task 3.3: `dagStore` is deliberately declared here (same closure scope as
  // `workerStore` above and the `getWidgetState()` builder below) so it is
  // directly reachable from getWidgetState() when it maps `dagStore.listAll()`
  // into AcpWidgetState.dags. No hoisting is required — the instance lives at
  // the extension-factory scope for the lifetime of the extension, matching
  // the pattern already used by `workerStore`.
  const dagStore = new DagStore({
    dagDir: runtimePaths.dagDir,
    dagIndexFile: runtimePaths.dagIndexFile,
  });
  const dagValidator = new DagValidator();
  const dagTemplateResolver = new TemplateResolver({
    truncateChars: config.dagOutputTruncateChars ?? 8000,
  });

  // ── Resume-on-startup hook (task 7.3, specs/dag-resume "Resume from last
  // checkpoint after pi restart") ──
  // On extension load, discover DAGs persisted in `running` state and resume
  // each from its last checkpoint. The resume pass is fire-and-forget: the
  // coordinator/executor construction and resumeAll() run inside an async
  // IIFE so a failure (e.g. unreadable runtime dir) is caught and logged
  // rather than thrown into the synchronous extension load path.
  (async () => {
    try {
      const resumeCoordinator = new AgentCoordinator(config, process.cwd(), {
        isHealthyFn: (name) => cb.isHealthy(name),
        recordSuccessFn: (name) => cb.recordSuccess(name),
        recordFailureFn: (name) => cb.recordFailure(name),
      });
      const resumeAsyncExecutor = new AsyncExecutor(resumeCoordinator, runtimePaths.rootDir);
      const resumeExecutor = new DagExecutor({
        store: dagStore,
        resolver: dagTemplateResolver,
        coordinator: resumeCoordinator,
        asyncExecutor: resumeAsyncExecutor,
        circuitBreaker: cb,
        logger,
        eventLog,
      });
      // Mark stale DAGs before resuming — a DAG with no step transitions
      // for longer than dagStaleTimeoutMs is transitioned to `stale` and
      // excluded from resume (specs/dag-stale-detection).
      const staleTimeoutMs = config.dagStaleTimeoutMs ?? 3_600_000;
      resumeExecutor.markStale(staleTimeoutMs);

      await resumeExecutor.resumeAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("DAG resume-on-startup failed", { error: message });
      eventLog.append("dag_resume_failed", { error: message });
    }
  })();

  function archiveSession(handle: AcpSessionHandle): AcpArchivedSessionMetadata {
    return sessionArchiveStore.upsert(handle);
  }

  async function closeSession(handle: AcpSessionHandle, closeReason: string, autoClosed = false): Promise<void> {
    // Idempotent: a handle already torn down must be a no-op. This lets the
    // completion / error call sites in acp_prompt invoke closeSession without
    // risk of double-disposing (e.g. error path after a completion teardown).
    if (handle.disposed) {
      return;
    }
    handle.autoClosed = autoClosed;
    handle.closeReason = closeReason;
    archiveSession(handle);
    // ACP Hooks: fire session_completed or session_failed (fire-and-forget)
    const isErrorClose = closeReason.includes("error") || closeReason.includes("fail") || closeReason.includes("stall");
    hookTriggers.onSessionRemoved(
      { id: handle.sessionId, agent: handle.agentName, cwd: handle.cwd ?? "" },
      { error: isErrorClose, errorMessage: closeReason },
    ).catch(() => {});
    // Invoke the canonical teardown directly rather than relying on
    // sessionMgr.remove to call handle.dispose(). This keeps teardown robust
    // even when the SessionManager is instrumented/mocked, and double-dispose
    // is prevented by the disposed guard on handle.dispose.
    await handle.dispose();
    await sessionMgr.remove(handle.sessionId);
    activeAdapters.delete(handle.sessionId);
    busySessions.delete(handle.sessionId);
    eventLog.append("session_closed", { sessionId: handle.sessionId, agentName: handle.agentName, closeReason, autoClosed });
  }

  /** A session is single-shot (auto-close on completion) when the caller did
   *  not request reuse via session_id/session_name. Such sessions are closed
   *  through `closeSession` once the prompt completes, so the adapter
   *  subprocess and registry entry do not leak.
   *  `dispose:true` is handled separately (ephemeral) and excluded here. */
  function shouldAutoCloseOnCompletion(params: { session_id?: string; session_name?: string; dispose?: boolean }): boolean {
    return !params.dispose && !params.session_id && !normalizeOptionalSessionName(params.session_name);
  }

  /** Auto-close a completed single-shot session on the next macrotask.
   *
   *  Deferral (rather than an inline `await closeSession` in the finally
   *  block) preserves re-entrancy for an immediate follow-up operation
   *  issued within the same synchronous stack (e.g. an `acp_cancel` or a
   *  reuse-by-id prompt that runs before control returns to the event
   *  loop): such a call still observes the live adapter in `activeAdapters`.
   *  Once the stack unwinds, the session is archived, the adapter subprocess
   *  is disposed, and the registry entry is removed — so independent
   *  subsequent operations no longer observe a leaked live session. */
  function scheduleCompletionClose(handle: AcpSessionHandle, params: { session_id?: string; session_name?: string; dispose?: boolean }): void {
    if (params.dispose || handle.disposed || !handle.completedAt) return;
    if (!shouldAutoCloseOnCompletion(params)) return;
    setImmediate(() => {
      if (handle.disposed) return;
      closeSession(handle, 'completed', false).catch((e) => logger.debug('deferred completion close failed', e));
    });
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

  function resolveSessionTarget(params: { session_id?: string; session_name?: string; agent?: string }): {
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

    // Agent validation: cross-check params.agent against archive metadata
    const resolvedTarget = byId ?? byName;
    if (resolvedTarget && params.agent) {
      const archivedAgent = resolvedTarget.agentName;
      if (archivedAgent && archivedAgent !== params.agent) {
        const targetLabel = sessionName ?? sessionId ?? "unknown";
        throw new Error(
          `Session "${targetLabel}" was created with agent "${archivedAgent}". ` +
          `Cannot resume with agent "${params.agent}". ` +
          `Omit the agent parameter to resume with the original agent.`,
        );
      }
    }

    if (sessionId) {
      return { sessionId, sessionName: byId?.sessionName ?? sessionNameStore.getName(sessionId) ?? sessionName, metadata: byId };
    }
    if (byName) {
      return { sessionId: byName.sessionId, sessionName, metadata: byName };
    }
    return { sessionId, sessionName, metadata: undefined };
  }

  const heartbeatDeps = {
    resolveWorkerName: (sid: string) => workerSessionMap.get(sid),
    touch: (name: string, deltas?: { tokenDelta?: number; toolCallDelta?: number }) =>
      workerStore().touch(name, deltas),
    logParseError: (entry: { workerName: string; sessionId: string; error: string }) =>
      eventLog.append("heartbeat_parse_error", entry),
  };

  /**
   * Heartbeat consumer — processes ACP session/update events for worker-bound sessions.
   * Extracts token/tool deltas and calls WorkerStore.touch().
   * (Tasks 2.1 + 2.2: defensive parsing + error logging in consumeHeartbeat)
   */
  function heartbeatConsumer(sessionId: string, update: import("@agentclientprotocol/sdk").SessionUpdate): void {
    consumeHeartbeat(heartbeatDeps, sessionId, update);
  }

  const monitor = new HealthMonitor({
    intervalMs: config.healthCheckIntervalMs ?? 5_000,
    staleTimeoutMs: config.staleTimeoutMs ?? 600_000,
    completedIdleTtlMs: config.completedIdleTtlMs ?? config.staleTimeoutMs ?? 600_000,
    needsAttentionMs: config.needsAttentionMs ?? 120_000,
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
      const closeReason = getSessionAutoCloseReason(handle, config.staleTimeoutMs ?? 600_000, undefined, config.completedIdleTtlMs ?? config.staleTimeoutMs ?? 600_000);

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
        // ACP Hooks: fire session_idle (fire-and-forget)
        hookTriggers.onSessionIdle({ id: sessionId, agent: handle.agentName, cwd: handle.cwd ?? "" }).catch(() => {});
        await closeSession(handle, closeReason, true);
        eventLog.append('session_stale', { sessionId, closeReason });
      }
    },
  });
  monitor.start();

  // ── Worker Dispatcher (tasks 3.1-3.8) ──
  let workerDispatcher: WorkerDispatcher | null = null;
  const workerAutoClaim = config.workerAutoClaim ?? true;

  if (workerAutoClaim) {
    const dispatchDeps: WorkerDispatcherDeps = {
      get workerStore() { return workerStore() as unknown as WorkerDispatcherDeps["workerStore"]; },
      get taskStore() { return taskStore() as unknown as WorkerDispatcherDeps["taskStore"]; },
      eventLog,
      busySessions,
      getSessionIdForWorker: (workerName: string) => {
        const worker = workerStore().get(workerName);
        if (!worker) return undefined;
        // Find sessionId from the workerSessionMap by reversing the lookup
        for (const [sid, name] of workerSessionMap.entries()) {
          if (name === workerName) return sid;
        }
        return undefined;
      },
      dispatchTask: async (sessionId: string, prompt: string) => {
        const adapter = activeAdapters.get(sessionId);
        if (!adapter) return { ok: false, error: "No adapter for session" };
        const workerName = workerSessionMap.get(sessionId) ?? "acp";
        const start = Date.now();
        // ACP Hooks: fire task_assigned (fire-and-forget)
        hookTriggers.onTaskDispatched({ id: sessionId, subject: prompt.slice(0, 200), status: "assigned", owner: workerName }).catch(() => {});
        // ACP Hooks: fire subagent_start (fire-and-forget)
        hookTriggers.onSubagentStart({ sessionId, agentName: workerName }).catch(() => {});
        try {
          busySessions.set(sessionId, true);
          const result = (await withTimeoutMs(adapter.prompt(prompt), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `dispatch:${sessionId}`)) as AcpPromptResult;
          // ACP Hooks: fire task_completed (fire-and-forget)
          hookTriggers.onTaskResult({ taskId: sessionId, subject: prompt.slice(0, 200), success: true, durationMs: Date.now() - start, result: result.text, owner: workerName }).catch(() => {});
          return { ok: true, value: result.text };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // ACP Hooks: fire task_failed (fire-and-forget)
          hookTriggers.onTaskResult({ taskId: sessionId, subject: prompt.slice(0, 200), success: false, durationMs: Date.now() - start, error: errMsg, owner: workerName }).catch(() => {});
          return { ok: false, error: errMsg };
        } finally {
          busySessions.delete(sessionId);
          // ACP Hooks: fire subagent_stop (fire-and-forget)
          hookTriggers.onSubagentStop({ sessionId, agentName: workerName }).catch(() => {});
        }
      },
    };
    workerDispatcher = new WorkerDispatcher(
      dispatchDeps,
      config.workerClaimIntervalMs ?? 5000,
    );
    workerDispatcher.start();
  }

  const getWidgetState = (): AcpWidgetState => ({
    sessions: sessionMgr.list().map((s) => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      agentName: s.agentName,
      cwd: s.cwd,
      status: ((): "error" | "active" | "stale" | "idle" => {
        if (s.disposed) return "error";
        if (busySessions.get(s.sessionId)) return "active";
        if (getSessionAutoCloseReason(s, config.staleTimeoutMs ?? 600_000, undefined, config.completedIdleTtlMs ?? config.staleTimeoutMs ?? 600_000)) return "stale";
        return "idle";
      })(),
      lastActivityAt: s.lastActivityAt,
      createdAt: s.createdAt,
      model: s.model,
    })),
    circuitBreakerState: cb.state as "closed" | "open" | "half-open",
    configuredAgentNames: Object.keys(config.agent_servers),
    configuredAliases: config.agent_aliases ? Object.keys(config.agent_aliases) : [],
    defaultAgent: config.defaultAgent,
    activity: { ...widgetActivity },
    workers: workerStore().list().map((w) => {
      const now = Date.now();
      const ageSec = Math.floor((now - new Date(w.lastActivityAt).getTime()) / 1000);
      const derived = deriveWorkerStatus(w);
      return {
        name: w.name,
        agentName: w.agentName,
        status: derived.status,
        tokenCountTotal: w.tokenCountTotal ?? 0,
        toolCallCount: w.toolCallCount ?? 0,
        ageSeconds: ageSec,
        stale: derived.stale || isWorkerStale(w),
        currentTaskId: w.currentTaskId,
      };
    }),
    // Task 3.2 / 3.4: populate `dags` from DagStore.listAll() — filter out
    // `pending`, sort by `updatedAt` desc, cap at 5 entries. Field-name
    // remapping DagIndexEntry → AcpWidgetDag is centralized and documented in
    // `dagIndexEntryToWidgetDag()` (see src/acp-widget.ts).
    dags: dagStore
      .listAll()
      .filter((e) => e.status !== "pending")
      .sort((a, b) => {
        if (a.updatedAt < b.updatedAt) return 1;
        if (a.updatedAt > b.updatedAt) return -1;
        return 0;
      })
      .slice(0, 5)
      .map((e) => dagIndexEntryToWidgetDag(e)),
  });

  // D1: render the interactive panel's overview mode into the live status slot.
  // Lazy getters ensure each render reads fresh state without rebuilding the
  // panel (which holds mode/selection state across renders). Mutation deps
  // throw (overview is read-only); D2 wires full mutations via ctx.ui.custom.
  const mapTaskToPanel = (t: AcpTaskRecord): AcpPanelTask => ({
    id: t.id,
    status: t.status,
    ownerId: t.assignee,
    blockedBy: t.blockedBy,
    qualityGateStatus: (t.metadata?.qualityGateStatus as AcpPanelTask["qualityGateStatus"]) ?? null,
    qualityGateSummary: (t.metadata?.qualityGateSummary as string | undefined),
  });
  // Cache the mapped task list to avoid synchronous disk reads (taskStore.list()
  // calls readFileSync) on every TUI paint frame. TTL keeps data fresh enough
  // for an overview while preventing I/O-per-frame stutter. Cache is also keyed
  // by store identity so a session/project switch (different store instance)
  // invalidates immediately rather than serving up to 1s of stale tasks.
  const TASKS_CACHE_TTL_MS = 1000;
  let cachedTasks: AcpPanelTask[] | null = null;
  let cachedTasksAt = 0;
  let cachedTasksStore: unknown = null;
  const getPanelTasks = (): AcpPanelTask[] => {
    const now = Date.now();
    const store = taskStore();
    if (cachedTasks && cachedTasksStore === store && now - cachedTasksAt < TASKS_CACHE_TTL_MS) {
      return cachedTasks;
    }
    cachedTasks = store.list().map(mapTaskToPanel);
    cachedTasksAt = now;
    cachedTasksStore = store;
    return cachedTasks;
  };
  const panelDeps = buildAcpPanelDepsReadOnly({
    getState: getWidgetState,
    getTasks: getPanelTasks,
  });
  const acpPanel = createAcpPanel(panelDeps);
  // pi's Theme (fg/bold/italic/dim) is shape-compatible with AcpPanelTheme —
  // pass it straight through so the panel renders with slot colors instead of
  // the monochrome default. Width is forwarded so the panel respects the slot.
  const widgetFactory = (
		_tui: unknown, theme: unknown,
	): { render(width: number): string[]; dispose?(): void } => ({
		render(width: number): string[] {
			return acpPanel.render(theme as Parameters<typeof acpPanel.render>[0], width);
		},
	});

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
    // Phase 3.1: Append random hex suffix to prevent name collisions across agents
    let resolvedSessionName = sessionName ?? metadata?.sessionName ?? sessionNameStore.getName(sessionId);
    if (resolvedSessionName) {
      const suffix = randomBytes(2).toString("hex"); // 4 hex chars
      resolvedSessionName = `${resolvedSessionName}-${suffix}`;
    }
    const handle: AcpSessionHandle = {
      sessionId,
      sessionName: resolvedSessionName,
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
        // Idempotent: a second dispose (e.g. closeSession after sessionMgr.remove
        // already disposed, or a redundant teardown path) must be a no-op so we
        // never double-dispose the adapter / subprocess.
        if (handle.disposed) return;
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
    // ACP Hooks: fire session_started (fire-and-forget, never blocks)
    hookTriggers.onSessionAdded({ id: sessionId, agent: agentName, cwd }).catch(() => {});
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

  // ── Unified tool surface (11 tools) ────────────────────────────────
  // acp_spawn : create a session (long-lived, one-shot with idleTtlMs:0,
  //             or worker with claim:true).
  // acp_msg   : prompt/cancel/steer a session or worker (alive/disposed/busy).
  // acp_fanout: broadcast/compare across multiple agents.
  // acp_governance: plan + model-policy actions.
  // acp_status: status display + action: cleanup|prune.
  // Consolidated task/message/dag tools retained as-is.

  // ── acp_spawn ──
  if (isToolEnabled(toolSettings, "acp_spawn")) pi.registerTool({
    name: "acp_spawn",
    label: "ACP Spawn",
    description: "Spawn an ACP agent session. Long-lived by default. With idleTtlMs:0 + prompt, runs one-shot and disposes after responding. With claim:true, registers as a persistent auto-claim worker.",
    promptSnippet: "acp_spawn — spawn an ACP agent session (long-lived, one-shot, or worker)",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name from config. Default: defaultAgent setting" })),
      name: Type.Optional(Type.String({ description: "Friendly session/worker name. Required when claim:true." })),
      prompt: Type.Optional(Type.String({ description: "Optional initial prompt to send immediately" })),
      claim: Type.Optional(Type.Boolean({ description: "If true, register this spawn as a persistent worker in the auto-claim pool." })),
      idleTtlMs: Type.Optional(Type.Number({ description: "Idle TTL in ms. 0 = one-shot (dispose after first response). Default: long-lived." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
      model: Type.Optional(Type.String({ description: "Model to set on the session" })),
      mode: Type.Optional(Type.String({ description: "Mode/thinking level to set on the session" })),
      async: Type.Optional(Type.Boolean({ description: "When true (default), spawn-with-prompt returns immediately with status:'prompting' and the prompt runs in the background. Completion fires a callback to the main session via the wake-subscriber. Set false to block and return the response inline (legacy behavior)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentName = getAgentName(params.agent);
      try {
        getAgentConfigOrThrow(agentName);
      } catch (error) {
        return { content: [textContent(String((error as Error).message))], details: { agent: agentName, error: "not found" } };
      }

      const oneShot = params.idleTtlMs === 0;
      const isWorker = !!params.claim;
      const sessionName = params.name?.trim() || undefined;

      if (isWorker) {
        if (!sessionName) {
          return { content: [textContent("claim:true requires a 'name' for the worker.")], details: { error: "missing_name" } };
        }
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionName)) {
          return { content: [textContent("Worker name must be 1-64 characters and contain only alphanumeric characters, hyphens, and underscores.")], details: { error: "invalid_name" } };
        }
        const existing = workerStore().get(sessionName);
        if (existing) {
          return { content: [textContent(`Worker '${sessionName}' already exists`)], details: { error: "duplicate_name", name: sessionName } };
        }
      }

      const result = await safeExecute(async () => {
        const agentCfg = getAgentConfigOrThrow(agentName);
        const effectiveCwd = params.cwd ?? ctx.cwd;
        const adapter = createAdapter(agentName, agentCfg, config, effectiveCwd, {
          onActivity: (sid) => monitor.touch(sid),
          onSessionUpdate: heartbeatConsumer,
        });
        let handle: AcpSessionHandle | undefined;
        try {
          await withTimeoutMs(adapter.spawn(), config.stallTimeoutMs, `acp_spawn(spawn:${agentName})`);
          await adapter.initialize();
          const sessionId = await adapter.newSession(effectiveCwd);
          if (params.model) await adapter.setModel(params.model);
          if (params.mode) await adapter.setMode(params.mode);
          handle = makeSessionHandle(sessionId, agentName, effectiveCwd, adapter, undefined, sessionName);
          activeAdapters.set(sessionId, adapter);

          if (isWorker && sessionName) {
            workerStore().register({ name: sessionName, sessionId, agentName });
            workerSessionMap.set(sessionId, sessionName);
            eventLog.append("worker_spawn", { name: sessionName, sessionId, agentName });
          } else if (sessionName) {
            sessionNameStore.register(sessionName, sessionId);
          }

          let promptText: string | undefined;
          // Persona injection: resolve per-alias systemPrompt (inline/file/gist-
          // deferred) and prepend to the first prompt of this fresh session.
          // Soft-fail: resolution never throws; warnings surface in the result.
          // NOTE: use the already-resolved agentCfg (handles aliases) rather than
          // config.agent_servers[agentName] (which misses alias-based spawns).
          const personaWarnings: string[] = [];
          if (params.prompt) {
            const persona = agentCfg?.systemPrompt
              ? resolvePersona(agentCfg.systemPrompt as string)
              : undefined;
            if (persona?.warning) personaWarnings.push(persona.warning);
            const effectivePrompt = persona?.text
              ? `${persona.text}\n\n---\n\n${params.prompt}`
              : params.prompt;
            busySessions.set(sessionId, true);
            handle.busy = true;
            handle.isPrompting = true;
            handle.promptStartedAt = new Date();
            monitor.markPromptStart(sessionId);
            archiveSession(handle);
            // ACP Hooks: fire subagent_start (fire-and-forget)
            hookTriggers.onSubagentStart({ sessionId, agentName, cwd: effectiveCwd }).catch(() => {});

            // ── Async spawn default (OT4) ──
            // When async !== false (default true), fire the prompt in the
            // background and return immediately with status:'prompting'.
            // The background work is STILL wrapped by safeExecute's circuit
            // breaker (cb.execute) via the outer wrapper — async ≠ no safety.
            // On background completion:
            //   - one-shot → existing closeSession fires session_completed
            //     (already in NEVER_DROP) → wake callback fires.
            //   - long-lived → fire spawn_completed (new event, in NEVER_DROP)
            //     → wake callback fires. Distinct from subagent_stop (per-turn)
            //     to avoid flooding the main session.
            const isAsyncSpawn = params.async !== false;

            if (isAsyncSpawn) {
              // Fire-and-forget background prompt. Errors surface via
              // event-log + session_failed hook (never silently swallowed).
              void (async () => {
                const promptTimeoutMs = config.toolTimeouts?.prompt ?? config.stallTimeoutMs;
                try {
                  const pr = (await withTimeoutMs(adapter.prompt(effectivePrompt), promptTimeoutMs, `acp_spawn(prompt:${sessionId})`)) as AcpPromptResult;
                  markPromptLifecycle(handle!, pr);
                  if (oneShot) {
                    await closeSession(handle!, "completed-oneshot", false);
                  } else {
                    // Long-lived async spawn completion → spawn_completed event
                    hookTriggers.onSpawnCompleted({ sessionId, agentName, cwd: effectiveCwd }).catch(() => {});
                  }
                } catch (bgErr) {
                  const errMsg = bgErr instanceof Error ? bgErr.message : String(bgErr);
                  logger.error(`background prompt failed for ${sessionId}: ${errMsg}`);
                  eventLog.append("operation_error", { label: `acp_spawn(prompt:${sessionId}):error`, error: errMsg });
                  if (oneShot) {
                    await closeSession(handle!, "error").catch(() => {});
                  } else {
                    hookTriggers.onSessionRemoved({ id: sessionId, agent: agentName, cwd: effectiveCwd }, { error: true, errorMessage: errMsg }).catch(() => {});
                  }
                } finally {
                  busySessions.delete(sessionId);
                  handle!.busy = false;
                  handle!.isPrompting = false;
                  monitor.markPromptEnd(sessionId);
                  archiveSession(handle!);
                  hookTriggers.onSubagentStop({ sessionId, agentName, cwd: effectiveCwd }).catch(() => {});
                }
              })();

              return { sessionId, sessionName: handle.sessionName, agent: agentName, oneShot, worker: isWorker, async: true, status: "prompting", warnings: personaWarnings.length > 0 ? personaWarnings : undefined };
            }

            // ── Sync (legacy) path: async:false → block on prompt ──
            try {
              const pr = (await withTimeoutMs(adapter.prompt(effectivePrompt), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `acp_spawn(prompt:${sessionId})`)) as AcpPromptResult;
              markPromptLifecycle(handle, pr);
              promptText = pr.text;
            } finally {
              busySessions.delete(sessionId);
              handle.busy = false;
              handle.isPrompting = false;
              monitor.markPromptEnd(sessionId);
              archiveSession(handle);
              // ACP Hooks: fire subagent_stop (fire-and-forget)
              hookTriggers.onSubagentStop({ sessionId, agentName, cwd: effectiveCwd }).catch(() => {});
            }
          }

          if (oneShot) {
            await closeSession(handle, "completed-oneshot", false);
          }

          return { sessionId, sessionName: handle.sessionName, agent: agentName, oneShot, worker: isWorker, text: promptText, warnings: personaWarnings.length > 0 ? personaWarnings : undefined };
        } catch (err) {
          if (handle) {
            await closeSession(handle, "error");
          } else {
            adapter.dispose();
          }
          throw new Error(err instanceof Error ? err.message : String(err), { cause: err });
        }
      }, `acp_spawn(${agentName})`);

      refreshWidget(ctx);
      if (result.ok) {
        const v = result.value;
        const warningLines = v.warnings && v.warnings.length > 0 ? v.warnings.map((w: string) => `⚠ ${w}`).join("\n") : "";
        // Async spawn: return status:prompting immediately (no inline text).
        if ((v as any).status === "prompting") {
          const body = `Spawned ${v.agent} session ${v.sessionId}${v.worker ? ` (worker: ${v.sessionName})` : ""}${v.oneShot ? " (one-shot)" : ""} — prompting in background`;
          return {
            content: [textContent(warningLines ? `${body}\n\n${warningLines}` : body)],
            details: { sessionId: v.sessionId, sessionName: v.sessionName, agent: v.agent, oneShot: v.oneShot, worker: v.worker, status: "prompting", warnings: v.warnings },
          } as AgentToolResult<{ sessionId: string; agent: string; oneShot: boolean; worker: boolean; status: string }>;
        }
        const body = v.text != null ? v.text : `Spawned ${v.agent} session ${v.sessionId}${v.worker ? ` (worker: ${v.sessionName})` : ""}${v.oneShot ? " (one-shot)" : ""}`;
        return {
          content: [textContent(warningLines ? `${body}\n\n${warningLines}` : body)],
          details: { sessionId: v.sessionId, sessionName: v.sessionName, agent: v.agent, oneShot: v.oneShot, worker: v.worker, warnings: v.warnings },
        } as AgentToolResult<{ sessionId: string; agent: string; oneShot: boolean; worker: boolean }>;
      }
      const prefix = result.circuitOpen ? "Circuit breaker open — too many failures. Retry later.\n" : "";
      return {
        content: [textContent(`${prefix}ACP spawn error (${agentName}): ${result.error}`)],
        details: { sessionId: "", agent: agentName, error: result.error, circuitOpen: result.circuitOpen },
      };
    },
  });

  // ── acp_msg (unified: session-level + mailbox-level) ──
  // Consolidates acp_msg (session-level: prompt/steer/cancel) + acp_message (mailbox: send/list).
  if (isToolEnabled(toolSettings, "acp_msg") || isToolEnabled(toolSettings, "acp_message")) pi.registerTool({
    name: "acp_msg",
    label: "ACP Msg",
    description: "Unified messaging. action:'send' routes to session (session_id) or mailbox (to). action:'list' returns mailbox messages. Session-level: alive->prompt, disposed->reopen, busy->steer. cancel:true aborts. Backward-compat: acp_message config key also gates this tool.",
    promptSnippet: "acp_msg — unified send/list: session prompt/steer/cancel + mailbox dm/steer/broadcast",
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "'send' (default) or 'list'" })),
      to: Type.Optional(Type.String({ description: "Target agent name (mailbox send), session id/name, or worker name. '*' = broadcast." })),
      session_id: Type.Optional(Type.String({ description: "Target a session by ID (session-level send/steer/cancel). Takes precedence over 'to'." })),
      message: Type.Optional(Type.String({ description: "Message/prompt text (required for action 'send')" })),
      kind: Type.Optional(Type.String({ description: "Mailbox kind: 'dm', 'steer', 'broadcast' (default: dm, or broadcast when to='*')" })),
      from: Type.Optional(Type.String({ description: "Sender name for mailbox send (default: 'user')" })),
      recipient: Type.Optional(Type.String({ description: "Recipient agent for action 'list'" })),
      filter: Type.Optional(Type.String({ description: "Filter for list: 'unread'" })),
      cancel: Type.Optional(Type.Boolean({ description: "If true, cancel the in-flight turn instead of prompting." })),
      queue: Type.Optional(Type.Boolean({ description: "Force queue-as-steer even if target is idle." })),
      agent: Type.Optional(Type.String({ description: "Agent override when reopening an archived session" })),
      cwd: Type.Optional(Type.String({ description: "Working directory when reopening" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "send";

      // ── action: "list" → mailbox list ──
      if (action === "list") {
        if (params.recipient) {
          const messages = mailboxManager().listFor(params.recipient);
          refreshWidget(ctx);
          return { content: [textContent(`${messages.length} messages for ${params.recipient}.`)], details: { messages } };
        }
        const messages = mailboxManager().listAll?.() ?? [];
        refreshWidget(ctx);
        return { content: [textContent(`${messages.length} total messages.`)], details: { messages } };
      }

      // ── invalid action → error ──
      if (action !== "send") {
        return { content: [textContent(`Unknown action: ${action}. Use 'send' or 'list'.`)], details: { error: "unknown_action" } };
      }

      // ── validate message for action 'send' ──
      const message = params.message;
      if (!message || (typeof message === "string" && message.trim() === "")) {
        return { content: [textContent(`Error: 'message' is required for action 'send'.`)], details: { error: "missing_message" } };
      }

      // ── MAILBOX SEND: `to` present without `session_id`, and not cancel/worker/session ──
      if (params.to && !params.session_id && !params.cancel) {
        const mbWorker = safeWorkerGet(params.to);
        let mbResolved = resolveSessionTarget({ session_name: params.to, agent: params.agent });
        if (!mbResolved.sessionId) mbResolved = resolveSessionTarget({ session_id: params.to, agent: params.agent });
        const mbSessionId = mbResolved.sessionId;
        const mbLiveHandle = mbSessionId ? sessionMgr.get(mbSessionId) : undefined;
        // If no worker and no resolved session metadata (live or archived) → mailbox send
        if (!mbWorker && !mbResolved.metadata && !(mbLiveHandle && !mbLiveHandle.disposed)) {
          const kind: "dm" | "steer" | "broadcast" = params.to === "*" ? "broadcast" : ((params.kind as "dm" | "steer" | "broadcast" | undefined) ?? "dm");
          const result = mailboxManager().send({ from: params.from ?? "user", to: params.to, message, kind });
          refreshWidget(ctx);
          return { content: [textContent(`Message sent to ${params.to} (${kind}).`)], details: { messageId: result.id } };
        }
      }

      // ── SESSION-LEVEL: session_id takes precedence, else `to` ──
      const target = params.session_id ?? params.to ?? "";
      if (!target) {
        return { content: [textContent(`Error: provide 'session_id' or 'to' for action 'send'.`)], details: { error: "missing_target" } };
      }

      // (1) Worker resolution.
      const worker = safeWorkerGet(target);
      if (worker) {
        const sessionId = worker.sessionId;
        if (params.cancel) {
          // Best-effort cancel: prefer the tracked adapter, but fall back to a
          // fresh one if the reference was lost (e.g. across hot reloads) so a
          // cancel request is always propagated to the provider.
          let adapter = activeAdapters.get(sessionId);
          if (!adapter) {
            try {
              const agentCfg = getAgentConfigOrThrow(worker.agentName);
              adapter = createAdapter(worker.agentName, agentCfg, config, params.cwd ?? ctx.cwd, { onActivity: (sid) => monitor.touch(sid) });
            } catch { /* agent unknown — leave adapter undefined */ }
          }
          if (adapter) { try { await adapter.cancel(); } catch { /* ignore */ } }
          eventLog.append("worker_cancel", { name: target, sessionId });
          refreshWidget(ctx);
          return { content: [textContent(`Cancel sent to worker '${target}'.`)], details: { name: target, sessionId, cancelled: true } };
        }
        const isBusy = !!worker.currentTaskId || !!busySessions.get(sessionId);
        if (isBusy || params.queue) {
          workerStore().updateMetadata(target, { pendingSteer: message });
          eventLog.append("worker_steer_queued", { name: target, sessionId, message, reason: isBusy ? "busy" : "forced" });
          refreshWidget(ctx);
          return { content: [textContent(`Steer queued for worker '${target}': ${message}`)], details: { name: target, message, queued: true } };
        }
        const adapter = activeAdapters.get(sessionId);
        if (adapter) {
          busySessions.set(sessionId, true);
          // ACP Hooks: fire subagent_start (fire-and-forget)
          hookTriggers.onSubagentStart({ sessionId, agentName: worker.agentName }).catch(() => {});
          try {
            const pr = (await withTimeoutMs(adapter.prompt(message), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `acp_msg(worker:${sessionId})`)) as AcpPromptResult;
            return { content: [textContent(pr.text || "(no response)")], details: { sessionId, name: target, agent: worker.agentName, queued: false } };
          } finally {
            busySessions.delete(sessionId);
            // ACP Hooks: fire subagent_stop (fire-and-forget)
            hookTriggers.onSubagentStop({ sessionId, agentName: worker.agentName }).catch(() => {});
          }
        }
      }

      // (2) Session name/id resolution. `to` is ONE of {session name, session id}; resolving
      // it as both would trip resolveSessionTarget's id/name conflict guard, so try name first,
      // then fall back to treating it as a raw session id.
      let resolved = resolveSessionTarget({ session_name: target, agent: params.agent });
      if (!resolved.sessionId) {
        resolved = resolveSessionTarget({ session_id: target, agent: params.agent });
      }
      const sessionId = resolved.sessionId;
      const liveHandle = sessionId ? sessionMgr.get(sessionId) : undefined;

      if (params.cancel) {
        if (!liveHandle || liveHandle.disposed) {
          return { content: [textContent(`Session "${target}" not found or disposed.`)], details: { sessionId, cancelled: false } };
        }
        const cancelResult = await safeExecute(async () => {
          const adapter = activeAdapters.get(liveHandle.sessionId) ?? createAdapter(liveHandle.agentName, getAgentConfigOrThrow(liveHandle.agentName), config, params.cwd ?? ctx.cwd, { onActivity: (sid) => monitor.touch(sid) });
          await adapter.cancel();
          const now = new Date();
          liveHandle.lastActivityAt = now;
          liveHandle.completedAt = now;
          archiveSession(liveHandle);
          eventLog.append("session_cancel", { sessionId: liveHandle.sessionId });
          return true;
        }, "acp_msg(cancel)");
        refreshWidget(ctx);
        if (cancelResult.ok) {
          return { content: [textContent(`Cancelled prompt on session ${liveHandle.sessionId}`)], details: { sessionId: liveHandle.sessionId, cancelled: true } };
        }
        return { content: [textContent(`Failed to cancel: ${cancelResult.error}`)], details: { sessionId: liveHandle.sessionId, cancelled: false } };
      }

      // Alive live session — reuse adapter.
      if (liveHandle && !liveHandle.disposed && sessionId && activeAdapters.has(sessionId)) {
        if (busySessions.get(sessionId)) {
          return { content: [textContent(`Session "${sessionId}" is busy; message queued.`)], details: { sessionId, queued: true } };
        }
        const reused = await safeExecute(async () => {
          busySessions.set(sessionId, true);
          liveHandle.busy = true;
          liveHandle.isPrompting = true;
          liveHandle.promptStartedAt = new Date();
          monitor.markPromptStart(sessionId);
          archiveSession(liveHandle);
          // ACP Hooks: fire subagent_start (fire-and-forget)
          hookTriggers.onSubagentStart({ sessionId, agentName: liveHandle.agentName, cwd: liveHandle.cwd }).catch(() => {});
          try {
            const adapter = activeAdapters.get(sessionId)!;
            const pr = (await withTimeoutMs(adapter.prompt(message), config.toolTimeouts?.prompt ?? config.stallTimeoutMs, `acp_msg(reused:${sessionId})`)) as AcpPromptResult;
            markPromptLifecycle(liveHandle, pr);
            eventLog.append("msg_reused_session", { sessionId, sessionName: liveHandle.sessionName });
            return pr;
          } finally {
            busySessions.delete(sessionId);
            liveHandle.busy = false;
            liveHandle.isPrompting = false;
            monitor.markPromptEnd(sessionId);
            archiveSession(liveHandle);
            // ACP Hooks: fire subagent_stop (fire-and-forget)
            hookTriggers.onSubagentStop({ sessionId, agentName: liveHandle.agentName, cwd: liveHandle.cwd }).catch(() => {});
          }
        }, `acp_msg(reused:${sessionId})`);
        refreshWidget(ctx);
        if (reused.ok) {
          return { content: [textContent(reused.value.text || "(no response)")], details: { sessionId, sessionName: liveHandle.sessionName, agent: liveHandle.agentName, queued: false } };
        }
        const p = reused.circuitOpen ? "Circuit breaker open — too many failures. Retry later.\n" : "";
        return { content: [textContent(`${p}ACP error: ${reused.error}`)], details: { sessionId, error: reused.error, circuitOpen: reused.circuitOpen } };
      }

      // Archived / disposed / fresh — reopen or create, then prompt.
      const reopened = await safeExecute(async () => {
        const agentName = params.agent ?? resolved.metadata?.agentName ?? liveHandle?.agentName ?? getAgentName(params.agent);
        getAgentConfigOrThrow(agentName);
        const agentCfg = getAgentConfigOrThrow(agentName);
        const effectiveCwd = params.cwd ?? resolved.metadata?.cwd ?? ctx.cwd;
        const adapter = createAdapter(agentName, agentCfg, config, effectiveCwd, {
          onActivity: (sid) => monitor.touch(sid),
          onSessionUpdate: heartbeatConsumer,
        });
        let handle: AcpSessionHandle | undefined;
        try {
          await withTimeoutMs(adapter.spawn(), config.staleTimeoutMs, `acp_msg(spawn:${agentName})`);
          await adapter.initialize();
          // ── Session-loadability tracking (restored from main) ──
          // When reopening an archived/disposed session, attempt to reload the
          // prior conversation. Track success/failure so permanently-unloadable
          // sessions skip the futile loadSession call and fall back to fresh.
          let newSessionId: string;
          let warningPrefix = ""; // prepended to the response when we could not recover history.
          const archived = (sessionId && (resolved.metadata || liveHandle?.disposed)) ? (resolved.metadata ?? liveHandle) : undefined;
          if (archived) {
            // Phase 3.4: Permanently unloadable (>=3 failed attempts) — skip loadSession.
            if (archived.loadStatus === "unloadable" && (archived.loadAttemptCount ?? 0) >= 3) {
              newSessionId = await adapter.newSession(effectiveCwd);
              warningPrefix = `[WARNING: Previous session could not be recovered. This is an entirely new session with no conversation history. Previous session was marked permanently unloadable after ${archived.loadAttemptCount} failed attempts.]\n`;
            } else {
              try {
                await adapter.loadSession(sessionId!);
                // Phase 3.3: successful load
                archived.loadStatus = "loadable";
                archived.lastLoadAttemptAt = new Date().toISOString();
                archived.loadAttemptCount = (archived.loadAttemptCount ?? 0) + 1;
                archiveSession(archived as AcpSessionHandle);
                newSessionId = sessionId!;
              } catch (loadErr) {
                // Phase 3.3: failed load — record and fall back to fresh.
                archived.loadStatus = "unloadable";
                archived.lastLoadAttemptAt = new Date().toISOString();
                archived.lastLoadError = (loadErr as Error).message;
                archived.loadAttemptCount = (archived.loadAttemptCount ?? 0) + 1;
                archiveSession(archived as AcpSessionHandle);
                newSessionId = await adapter.newSession(effectiveCwd);
                warningPrefix = `[WARNING: Previous session could not be recovered. This is an entirely new session with no conversation history. Error: ${(loadErr as Error).message}]\n`;
              }
            }
          } else {
            newSessionId = await adapter.newSession(effectiveCwd);
          }
          handle = makeSessionHandle(newSessionId, agentName, effectiveCwd, adapter, undefined, resolved.sessionName);
          activeAdapters.set(newSessionId, adapter);
          if (resolved.sessionName) sessionNameStore.register(resolved.sessionName, newSessionId);
          busySessions.set(newSessionId, true);
          handle.busy = true;
          handle.isPrompting = true;
          handle.promptStartedAt = new Date();
          monitor.markPromptStart(newSessionId);
          archiveSession(handle);
          // ACP Hooks: fire subagent_start (fire-and-forget)
          hookTriggers.onSubagentStart({ sessionId: newSessionId, agentName, cwd: effectiveCwd }).catch(() => {});
          try {
            const pr = (await withTimeoutMs(adapter.prompt(message), config.toolTimeouts?.prompt ?? config.staleTimeoutMs, `acp_msg(prompt:${newSessionId})`)) as AcpPromptResult;
            if (warningPrefix) pr.text = `${warningPrefix}${pr.text}`;
            markPromptLifecycle(handle, pr);
            eventLog.append("msg_prompt", { sessionId: newSessionId, sessionName: handle.sessionName });
            return pr;
          } finally {
            busySessions.delete(newSessionId);
            handle.busy = false;
            handle.isPrompting = false;
            monitor.markPromptEnd(newSessionId);
            archiveSession(handle);
            // ACP Hooks: fire subagent_stop (fire-and-forget)
            hookTriggers.onSubagentStop({ sessionId: newSessionId, agentName, cwd: effectiveCwd }).catch(() => {});
          }
        } catch (err) {
          if (handle) {
            await closeSession(handle, "error");
          } else {
            adapter.dispose();
          }
          throw new Error(err instanceof Error ? err.message : String(err), { cause: err });
        }
      }, `acp_msg(${target})`);
      refreshWidget(ctx);
      if (reopened.ok) {
        return { content: [textContent(reopened.value.text || "(no response)")], details: { agent: params.agent ?? resolved.metadata?.agentName ?? getAgentName(params.agent), queued: false } };
      }
      const p = reopened.circuitOpen ? "Circuit breaker open — too many failures. Retry later.\n" : "";
      return { content: [textContent(`${p}ACP error: ${reopened.error}`)], details: { error: reopened.error, circuitOpen: reopened.circuitOpen } };
    },
  });

  // ── acp_governance ──
  if (isToolEnabled(toolSettings, "acp_governance")) pi.registerTool({
    name: "acp_governance",
    label: "ACP Governance",
    description: "Plan approval and model-policy governance. action: plan_request | plan_resolve | model_policy_get | model_policy_check.",
    promptSnippet: "acp_governance — plan approval + model policy",
    parameters: Type.Object({
      action: Type.String({ description: "One of: plan_request, plan_resolve, model_policy_get, model_policy_check" }),
      agent: Type.Optional(Type.String({ description: "Agent name (for plan_request/plan_resolve)" })),
      status: Type.Optional(Type.String({ description: "Approval status for plan_resolve: 'approved' or 'rejected'" })),
      feedback: Type.Optional(Type.String({ description: "Optional feedback for plan_resolve" })),
      model: Type.Optional(Type.String({ description: "Model id for model_policy_check" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const gs = governanceStore();
      switch (params.action) {
        case "plan_request": {
          const agent = requireString(params.agent, "agent");
          const req = gs.requestPlan(agent);
          eventLog.append("plan_request", { agent });
          refreshWidget(ctx);
          return { content: [textContent(formatJson(req))], details: req };
        }
        case "plan_resolve": {
          const agent = requireString(params.agent, "agent");
          const status = requireString(params.status, "status");
          if (status !== "approved" && status !== "rejected") {
            return { content: [textContent("status must be 'approved' or 'rejected'")], details: { error: "invalid_status" } };
          }
          const req = gs.resolvePlan(agent, status as "approved" | "rejected", ...(params.feedback !== undefined ? [params.feedback] : []));
          eventLog.append("plan_resolve", { agent, status });
          refreshWidget(ctx);
          return { content: [textContent(formatJson(req))], details: req };
        }
        case "model_policy_get": {
          const policy = gs.getModelPolicy();
          refreshWidget(ctx);
          return { content: [textContent(formatJson(policy))], details: policy };
        }
        case "model_policy_check": {
          const result = gs.checkModel(params.model);
          refreshWidget(ctx);
          return { content: [textContent(formatJson(result))], details: result };
        }
        default:
          return { content: [textContent(`Unknown action: ${params.action}. Use plan_request | plan_resolve | model_policy_get | model_policy_check.`)], details: { error: "unknown_action", action: params.action } };
      }
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
      action: Type.Optional(Type.String({ description: "Maintenance action: 'prune' (mark stale workers offline) or 'cleanup' (remove sessions + clear tasks/mailboxes). Omit for status display." })),
      target: Type.Optional(Type.String({ description: "Cleanup target: 'all', 'sessions', 'tasks', 'mailboxes'. Default: 'all'." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      config = loadConfig();
      governanceStore().setModelPolicy(config.modelPolicy ?? {});

      // ── action: prune — absorb acp_worker_prune ──
      // Mark all stale (derived) workers offline and unassign their tasks.
      if (params.action === "prune") {
        const workers = workerStore().list();
        const pruned: string[] = [];
        for (const w of workers) {
          if (w.status === "offline") continue;
          const derived = deriveWorkerStatus(w);
          if (derived.stale || isWorkerStale(w)) {
            if (w.currentTaskId) {
              try {
                taskStore().update(w.currentTaskId, (t) => { t.status = "pending"; });
              } catch { /* ignore */ }
              workerStore().unassignTask(w.name);
            }
            workerStore().updateStatus(w.name, "offline");
            pruned.push(w.name);
          }
        }
        eventLog.append("worker_prune", { pruned });
        refreshWidget(ctx);
        return {
          content: [textContent(pruned.length > 0 ? `Pruned ${pruned.length} stale workers: ${pruned.join(", ")}` : "No stale workers found")],
          details: { pruned, count: pruned.length },
        };
      }

      // ── action: cleanup — absorb acp_cleanup ──
      // Remove sessions and/or clear tasks/mailboxes per target.
      if (params.action === "cleanup") {
        const target = params.target ?? "all";
        const removedSessions: string[] = [];
        if (target === "all" || target === "sessions") {
          for (const s of sessionMgr.list()) {
            await sessionMgr.remove(s.sessionId);
            const adapter = activeAdapters.get(s.sessionId);
            if (adapter) { adapter.dispose(); activeAdapters.delete(s.sessionId); }
            removedSessions.push(s.sessionId);
          }
        }
        if (target === "all" || target === "tasks") {
          taskStore().clear("all");
        }
        if (target === "all" || target === "mailboxes") {
          for (const name of [...Object.keys(config.agent_servers), "*"]) {
            mailboxManager().clearFor(name);
          }
        }
        eventLog.append("cleanup", { target, removedSessions });
        refreshWidget(ctx);
        return {
          content: [textContent(`Cleanup (${target}): removed ${removedSessions.length} session(s).`)],
          details: { target, removedSessions },
        };
      }

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
        .map(([name, cfg]) => {
          const desc = typeof cfg.description === "string" && cfg.description.length > 0 ? cfg.description : "(no description)";
          return `  ${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")} — ${desc}`;
        })
        .join("\n");
      const sessionLines = sessionMgr.list().map((s) => `  ${s.sessionName ? `${s.sessionName} ` : ""}${s.sessionId} (${s.agentName}) — ${s.cwd}`).join("\n");
      refreshWidget(ctx);
      return {
        content: [textContent(
          `ACP Agent Servers Status\n─────────────────\nCircuit Breaker: ${cb.state}\nAgent Servers: ${Object.keys(config.agent_servers).length} configured\nAliases: ${config.agent_aliases ? Object.keys(config.agent_aliases).length : 0}\nDefault: ${config.defaultAgent ?? "none"}\n\nAgent Servers:\n${agentLines || "  (none)"}${config.agent_aliases ? `\n\nAliases:\n${Object.entries(config.agent_aliases).map(([name, cfg]) => `  ${name} → [${cfg.agents.join(", ")}] (${cfg.strategy})`).join("\n")}` : ""}\n\nActive Sessions (${sessionMgr.size}):\n${sessionLines || "  (none)"}`,
        )],
        details: {
          circuitBreaker: cb.state,
          agentCount: Object.keys(config.agent_servers).length,
          sessionCount: sessionMgr.size,
          agents: Object.entries(config.agent_servers).map(([name, cfg]) => ({
            name,
            command: cfg.command,
            description: typeof cfg.description === "string" && cfg.description.length > 0 ? cfg.description : undefined,
          })),
        },
      };
    },
  });

  // Unified dispatch tools

  if (isToolEnabled(toolSettings, "acp_fanout")) pi.registerTool({
    name: "acp_fanout",
    label: "ACP Fanout",
    description: "Send a prompt to multiple ACP agents in parallel, or compare their responses. Consolidates delegate_parallel, broadcast, and compare into one tool.",
    promptSnippet: "acp_fanout — fan out a message to multiple agents (optionally compare)",
    parameters: Type.Object({
      message: Type.String({ description: "Prompt to send to all agents" }),
      agents: Type.Optional(Type.Array(Type.String(), { description: "Agent names. Default: all configured agents" })),
      compare: Type.Optional(Type.Boolean({ description: "If true, route through the compare path and return a structured comparison. Default: false (broadcast)." })),
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
      try {
      if (params.compare) {
        beginWidgetActivity("compare", ctx);
        const result = await safeExecute(async () => {
          const output = await coordinator.compare(agentNames, params.message, params.cwd ?? ctx.cwd);
          eventLog.append("fanout_compare", { agentNames, cwd: params.cwd ?? ctx.cwd });
          return output;
        }, `acp_fanout(compare:${agentNames.join(",")})`, { timeoutMs: config.toolTimeouts?.broadcast ?? config.stallTimeoutMs });
        if (!result.ok) {
          endWidgetActivity("compare", ctx, result.error);
          return { content: [textContent(`Compare failed: ${result.error}`)], details: { error: result.error, circuitOpen: result.circuitOpen } };
        }
        endWidgetActivity("compare", ctx);
        return { content: [textContent(formatJson(result.value))], details: result.value };
      }
      beginWidgetActivity("broadcast", ctx);
      const result = await safeExecute(async () => {
        const output = await coordinator.broadcast(agentNames, params.message, params.cwd ?? ctx.cwd);
        eventLog.append("fanout_broadcast", { agentNames, cwd: params.cwd ?? ctx.cwd });
        return output;
      }, `acp_fanout(${agentNames.join(",")})`, { timeoutMs: config.toolTimeouts?.broadcast ?? config.stallTimeoutMs });
      if (!result.ok) {
        endWidgetActivity("broadcast", ctx, result.error);
        return { content: [textContent(`Fanout failed: ${result.error}`)], details: { results: [], error: result.error, circuitOpen: result.circuitOpen } };
      }
      const lines = result.value.map((r) => r.error ? `── ${r.agent} ──\n(ERROR: ${r.error})` : `── ${r.agent} ──\n${r.text}`);
      endWidgetActivity("broadcast", ctx);
      return { content: [textContent(`Fanout results:\n\n${lines.join("\n\n")}`)], details: { results: result.value } };
      } finally {
        coordinator?.dispose?.();
      }
    },
  });


  // Parallel delegation tool

  // ── Consolidated tools (33→7 mode) ──
  // ── acp_task (unified: create + update) ──
  if (isToolEnabled(toolSettings, "acp_task") || isToolEnabled(toolSettings, "acp_task_create") || isToolEnabled(toolSettings, "acp_task_update")) pi.registerTool({
    name: "acp_task",
    label: "ACP Task",
    description: "Create or update persistent ACP tasks. action:'create' makes a new task; action:'update' modifies status/assignee/deps/result. Supports bulk ops with task_id='*'.",
    promptSnippet: "acp_task — create or update ACP tasks",
    parameters: Type.Object({
      action: Type.String({ description: "'create' or 'update'" }),
      subject: Type.Optional(Type.String({ description: "Task subject (required for create)" })),
      description: Type.Optional(Type.String({ description: "Task description (for create)" })),
      assignee: Type.Optional(Type.String({ description: "Assign to agent (for create or update)" })),
      deps: Type.Optional(Type.Array(Type.String(), { description: "Dependencies (for create)" })),
      task_id: Type.Optional(Type.String({ description: "Task ID for update, or '*' for bulk" })),
      status: Type.Optional(Type.String({ description: "New status (for update): pending, in_progress, completed, deleted" })),
      deps_add: Type.Optional(Type.Array(Type.String(), { description: "Add dependencies (for update)" })),
      deps_remove: Type.Optional(Type.Array(Type.String(), { description: "Remove dependencies (for update)" })),
      result: Type.Optional(Type.String({ description: "Store result text (for update)" })),
      filter: Type.Optional(Type.String({ description: "Filter for bulk ops: 'completed', 'pending', 'in_progress'" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "create") {
        if (!params.subject) {
          return { content: [textContent("Error: subject is required for action:'create'.")], details: { error: "missing_subject" } };
        }
        const task = taskStore().create({
          subject: params.subject,
          description: params.description,
          assignee: params.assignee,
          deps: params.deps,
        });
        eventLog.append("task_create", { taskId: task.id, assignee: task.assignee });
        return { content: [textContent(formatJson(task))], details: task };
      }

      if (params.action === "update") {
        if (!params.task_id) {
          return { content: [textContent("Error: task_id is required for action:'update' (use '*' for bulk).")], details: { error: "missing_task_id" } };
        }

        // Bulk operation
        if (params.task_id === "*") {
          const filter = params.filter ?? "";
          const updated = taskStore().updateWhere(filter, (t: any) => {
            if (params.status) t.status = params.status;
            if (params.assignee !== undefined) t.assignee = params.assignee || null;
            if (params.result) t.result = params.result;
            t.updatedAt = new Date().toISOString();
          });
          return { content: [textContent(`Bulk updated ${updated.length} tasks matching '${filter}'.`)], details: { updated: updated.length } };
        }

        // Single task
        const updated = taskStore().update(params.task_id, (t: any) => {
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
          return { content: [textContent(`Error: task ${params.task_id} not found.`)], details: { error: "not_found" } };
        }
        return { content: [textContent(`Task ${params.task_id} updated.`)], details: { task: updated } };
      }

      return { content: [textContent(`Error: unknown action '${params.action}'. Use 'create' or 'update'.`)], details: { error: "unknown_action" } };
    },
  });

  // (acp_message folded into unified acp_msg above — mailbox send/list now via acp_msg action)

  // Lifecycle / management tools


  // (acp_task_create + acp_task_update consolidated into acp_task above)

  // Messaging + governance + diagnostics


  function showAcpConfig(ctx: { ui: { notify: Function; setWidget: Function } }): void {
    config = loadConfig();
    const agents = Object.entries(config.agent_servers)
      .map(([name, cfg]) => {
        const desc = typeof cfg.description === "string" && cfg.description.length > 0 ? cfg.description : "(no description)";
        return `${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")} — ${desc}`;
      })
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
      agents: Object.entries(config.agent_servers).map(([name, cfg]) => ({
        name,
        command: cfg.command,
        // D3: machine-readable payload → undefined (not the human placeholder) when missing.
        description: typeof cfg.description === "string" && cfg.description.length > 0 ? cfg.description : undefined,
      })),
      defaultAgent: config.defaultAgent,
      sessionCount: sessionMgr.size,
      runtimeDir: runtimePaths.rootDir,
      circuitBreaker: cb.state,
    };
    ctx.ui.notify(formatJson(payload), "info");
    refreshWidget(ctx);
  }

  /**
   * D2: open the interactive ACP panel overlay via ctx.ui.custom().
   *
   * The overlay wraps `createAcpPanel` with full mutation deps (sendMessage,
   * abort/kill, task reassign/unassign, transcript). Esc or `q` exits and
   * restores editor focus via `done()`.
   */
  async function openAcpPanelOverlay(ctx: {
    ui: { custom: Function; notify: Function; setWidget: Function };
    cwd?: string;
  }): Promise<void> {
    // Full mutation deps — best-effort, never throw (panel re-renders on state).
    const fullSources = {
      getState: getWidgetState,
      getTasks: getPanelTasks,
      sendMessage: async (to: string, text: string): Promise<void> => {
        mailboxManager().send({ from: hostSessionId ?? "panel", to, message: text, kind: "dm" });
      },
      abortEntity: (entityId: string): void => {
        // entityId may be a worker name (workers map id→name) or a sessionId.
        // Resolve to the underlying sessionId before touching sessionMgr.
        const sessionId = workerStore().get(entityId)?.sessionId ?? entityId;
        const handle = sessionMgr.get(sessionId);
        const adapter = handle ? activeAdapters.get(handle.sessionId) : undefined;
        if (adapter) { adapter.cancel().catch(() => {}); }
      },
      killEntity: (entityId: string): void => {
        const sessionId = workerStore().get(entityId)?.sessionId ?? entityId;
        const handle = sessionMgr.get(sessionId);
        if (handle) { closeSession(handle, "panel-kill").catch(() => {}); }
        else { workerStore().updateStatus(entityId, "offline"); }
      },
      reassignTask: async (taskId: string, newOwner: string): Promise<boolean> => {
        try {
          taskStore().update(taskId, (t) => { t.assignee = newOwner; });
          return true;
        } catch (e) {
          logger.debug("panel reassignTask failed", e);
          return false;
        }
      },
      unassignTask: async (taskId: string): Promise<boolean> => {
        try {
          taskStore().update(taskId, (t) => { t.assignee = undefined; });
          return true;
        } catch (e) {
          logger.debug("panel unassignTask failed", e);
          return false;
        }
      },
      getTranscript: (): [] => [],
    };
    const panelDeps = buildAcpPanelDepsFull(fullSources);
    const acpPanel = createAcpPanel(panelDeps);

    try {
      await ctx.ui.custom(
        (_tui: unknown, theme: unknown, _kb: unknown, done: (result: unknown) => void) => ({
          render(width: number): string[] {
            return acpPanel.render(theme as Parameters<typeof acpPanel.render>[0], width);
          },
          invalidate(): void {
            // Panel reads live state each render via deps; nothing to invalidate.
          },
          async handleInput(data: string): Promise<void> {
            // Map raw escape byte to the panel's expected "Escape" key name.
            const key = data === "\u001b" ? "Escape" : data;
            const currentMode = acpPanel.getMode();
            // Only Esc/q exits the overlay, and only from overview mode — so
            // Esc in a sub-mode returns to overview (panel's own behavior) and
            // 'q' in dm compose is typed, not treated as exit.
            if (currentMode === "overview" && (key === "Escape" || key === "q")) {
              done(undefined);
              return;
            }
            try {
              await acpPanel.handleKey(key);
            } catch (e) {
              logger.debug("panel handleKey failed", e);
            }
          },
        }),
        { overlay: true },
      );
    } catch (e) {
      ctx.ui.notify(`Failed to open ACP panel: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
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
    panel: [],
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
      "/acp panel — open interactive 5-mode overlay (Esc/q to exit)",
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

      // D2: `/acp panel` opens the interactive 5-mode overlay (overview/session/
      // dm/tasks/reassign) via ctx.ui.custom(). Esc or `q` exits.
      if (group === "panel") {
        await openAcpPanelOverlay(ctx);
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

  /**
   * Derive worker status from liveliness signals (LIVELINESS-1).
   * - online: activity < workerOnlineMs
   * - busy: has in-flight task (currentTaskId set)
   * - idle: no task, activity < workerStaleMs
   * - stale(Ns): activity > workerStaleMs
   */
  function deriveWorkerStatus(worker: import("./src/config/types.js").AcpWorkerRecord): { status: string; stale: boolean } {
    const now = Date.now();
    const lastActivity = new Date(worker.lastActivityAt).getTime();
    const ageMs = now - lastActivity;
    const onlineMs = config.workerOnlineMs ?? 60_000;
    const staleMs = config.workerStaleMs ?? 60_000;

    // If offline in the store, keep offline
    if (worker.status === "offline") {
      return { status: "offline", stale: false };
    }

    // Busy if has in-flight task
    if (worker.currentTaskId) {
      return { status: "busy", stale: false };
    }

    // Stale if activity exceeds threshold
    if (ageMs > staleMs) {
      const ageSec = Math.floor(ageMs / 1000);
      return { status: `stale(${ageSec}s)`, stale: true };
    }

    // Online if recently active
    if (ageMs < onlineMs) {
      return { status: "online", stale: false };
    }

    // Idle: no task, activity between online and stale thresholds
    return { status: "idle", stale: false };
  }

  /**
   * Check if worker is stale (⚠ stale indicator).
   * All three signals frozen: tokenCountTotal, toolCallCount, lastActivityAt
   * beyond stallTimeoutMs with no change.
   */
  function isWorkerStale(worker: import("./src/config/types.js").AcpWorkerRecord): boolean {
    const stallMs = config.stallTimeoutMs ?? 300_000;
    const now = Date.now();
    const ageMs = now - new Date(worker.lastActivityAt).getTime();
    // If lastActivity was recent enough, not stale
    if (ageMs < stallMs) return false;
    // If tokens have been used, signals aren't frozen
    if ((worker.tokenCountTotal ?? 0) > 0) return false;
    // If tools have been called, signals aren't frozen
    if ((worker.toolCallCount ?? 0) > 0) return false;
    // All signals frozen beyond stall timeout
    return true;
  }

  // ── DAG tools (consolidated into unified acp_dag) ─────────────────────
  // Consolidates acp_dag_submit + acp_dag_status + acp_dag_cancel.
  // Backward-compat: any of the legacy config keys (acp_dag_submit, _status, _cancel)
  // enables the unified acp_dag tool.
  if (
    isToolEnabled(toolSettings, "acp_dag") ||
    isToolEnabled(toolSettings, "acp_dag_submit") ||
    isToolEnabled(toolSettings, "acp_dag_status") ||
    isToolEnabled(toolSettings, "acp_dag_cancel")
  ) pi.registerTool({
    name: "acp_dag",
    label: "ACP DAG",
    description: "Unified DAG operations. action:'submit' validates + creates + starts background wave execution; action:'status' returns one DAG (dag_id) or lists all; action:'cancel' aborts a running DAG.",
    promptSnippet: "acp_dag — submit/status/cancel a DAG of ACP agent tasks",
    parameters: Type.Object({
      action: Type.String({ description: "'submit' | 'status' | 'cancel'" }),
      dag: Type.Optional(Type.Object({
        nodes: Type.Array(Type.Object({
          id: Type.String({ description: "Unique step identifier" }),
          agent: Type.String({ description: "Agent name (must exist in agent_servers config)" }),
          prompt: Type.String({ description: "Prompt text. May contain {<step-id>.output}, {<step-id>.status}, {dag.args.<key>} template variables." }),
          deps: Type.Optional(Type.Array(Type.String(), { description: "Step IDs this step depends on (default: [])" })),
          dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Alias for deps (legacy compat)" })),
          gate: Type.Optional(Type.Union([Type.Literal("needs"), Type.Literal("after")], { description: "Gate type for ALL dependencies. needs = success-gate (default), after = completion-gate" })),
        }), { description: "DAG node definitions" }),
        args: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Workflow-level arguments for {dag.args.*} template variables" })),
        options: Type.Optional(Type.Object({
          failFast: Type.Optional(Type.Boolean({ description: "On failure, skip transitive dependents. Default: true" })),
          maxRetries: Type.Optional(Type.Number({ description: "Retry attempts per step on failure. Default: 0" })),
        })),
        tasks: Type.Optional(Type.Array(Type.Any(), { description: "Legacy raw task array (pre-node-shape). Passed through as-is." })),
      }, { description: "DAG definition (for action:'submit'). Shape: { nodes: [...], args: {...}, options: {...} }. Backward-compat: a raw tasks array under .tasks is passed through." })),
      tasks: Type.Optional(Type.Array(Type.Any(), { description: "Legacy: raw DAG tasks array (alternative to dag.nodes). Used if dag omitted." })),
      dag_id: Type.Optional(Type.String({ description: "DAG ID for action:'status' or 'cancel'. Omit for status to list all." })),
      dagId: Type.Optional(Type.String({ description: "Alias for dag_id (legacy compat)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for all DAG steps (action:'submit')" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<any>> {
      const action = params.action;

      // ── action: submit ──
      if (action === "submit") {
        // Normalize the DAG shape: accept dag.nodes, dag.tasks, or top-level tasks.
        const dag: any = params.dag ?? {};
        let tasks: any[] | undefined;
        if (Array.isArray(dag.nodes) && dag.nodes.length > 0) {
          // Map node shape → legacy task shape (id, agent, prompt, dependsOn/deps).
          tasks = dag.nodes.map((n: any) => ({
            id: n.id,
            agent: n.agent,
            prompt: n.prompt,
            dependsOn: n.dependsOn ?? n.deps ?? [],
            gate: n.gate,
          }));
        } else if (Array.isArray(dag.tasks) && dag.tasks.length > 0) {
          tasks = dag.tasks;
        } else if (Array.isArray(params.tasks) && params.tasks.length > 0) {
          tasks = params.tasks;
        }

        if (!tasks || tasks.length === 0) {
          return { content: [textContent("Error: action 'submit' requires a non-empty DAG (dag.nodes, dag.tasks, or tasks).")], details: { error: "no_dag" } };
        }

        // 1. Static validation against the configured agent set.
        const agentNames = new Set(Object.keys(config.agent_servers));
        const validation = dagValidator.validate(tasks, agentNames);
        if (!validation.valid) {
          const message = `DAG validation failed: ${validation.errors.join("; ")}`;
          eventLog.append("dag_submit_rejected", { errors: validation.errors });
          return { content: [textContent(message)], details: { error: "validation_failed", violations: validation.errors } };
        }

        // 2. Create the DAG record via the file-backed store.
        //    Backward-compat: also accept top-level args/options when dag object omitted.
        const record = dagStore.create({
          tasks,
          args: dag.args ?? (params as any).args,
          options: dag.options ?? (params as any).options ?? {},
        });

        // 3. Build a per-call coordinator + executor with the current cwd and
        //    circuit breaker, then kick off execution in the background
        //    (fire-and-forget). The dagId is returned immediately.
        const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd, {
          isHealthyFn: (name) => cb.isHealthy(name),
          recordSuccessFn: (name) => cb.recordSuccess(name),
          recordFailureFn: (name) => cb.recordFailure(name),
        });
        const asyncExecutor = new AsyncExecutor(coordinator, runtimePaths.rootDir);
        const dagExecutor = new DagExecutor({
          store: dagStore,
          resolver: dagTemplateResolver,
          coordinator,
          asyncExecutor,
          circuitBreaker: cb,
          logger,
          eventLog,
        });

        // Fire-and-forget: errors are captured per step into the DAG state file.
        dagExecutor.execute(record.dagId).catch((err) => {
          logger.error(`acp_dag(submit) background execution failed for dagId=${record.dagId}`, { error: err instanceof Error ? err.message : String(err) });
          eventLog.append("dag_execute_failed", { dagId: record.dagId, error: err instanceof Error ? err.message : String(err) });
        }).finally(() => {
          coordinator?.dispose?.();
        });

        eventLog.append("dag_submitted", { dagId: record.dagId, stepCount: tasks.length });
        return {
          content: [textContent(`Submitted DAG "${record.dagId}" with ${tasks.length} step(s). Execution started in the background.`)],
          details: { dagId: record.dagId, stepCount: tasks.length },
        };
      }

      // ── action: status ──
      if (action === "status") {
        const dagId = (params.dag_id ?? params.dagId ?? "").trim();

        // Listing mode: no dagId provided → return all DAGs from the index.
        if (!dagId) {
          const dags = dagStore.listAll();
          return {
            content: [textContent(formatJson({ dags }))],
            details: { dags, count: dags.length },
          };
        }

        // Detail mode: dagId provided → return the full DAG record.
        const record = dagStore.get(dagId);
        if (!record) {
          return {
            content: [textContent(`DAG "${dagId}" not found`)],
            details: { error: "not_found", dagId },
          };
        }

        return {
          content: [textContent(formatJson(record))],
          details: { dagId, status: record.status, currentWave: record.currentWave, totalWaves: record.totalWaves },
        };
      }

      // ── action: cancel ──
      if (action === "cancel") {
        const dagId = (params.dag_id ?? params.dagId ?? "").toString().trim();
        if (!dagId) {
          return {
            content: [textContent("Error: action 'cancel' requires a dag_id.")],
            details: { error: "missing_dag_id" },
          };
        }

        // Build a per-call coordinator + executor (same wiring as submit).
        // DagExecutor.cancel() reads the persisted step states from the
        // DagStore to tally the summary and abort in-flight sessions.
        const coordinator = new AgentCoordinator(config, ctx.cwd, {
          isHealthyFn: (name) => cb.isHealthy(name),
          recordSuccessFn: (name) => cb.recordSuccess(name),
          recordFailureFn: (name) => cb.recordFailure(name),
        });
        const asyncExecutor = new AsyncExecutor(coordinator, runtimePaths.rootDir);
        const dagExecutor = new DagExecutor({
          store: dagStore,
          resolver: dagTemplateResolver,
          coordinator,
          asyncExecutor,
          circuitBreaker: cb,
          logger,
          eventLog,
        });

        try {
          const summary: DagCancelSummary = await dagExecutor.cancel(dagId);
          eventLog.append("dag_cancelled", { dagId, ...summary });
          return {
            content: [textContent(formatJson({ dagId, ...summary }))],
            details: { dagId, ...summary },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`acp_dag(cancel) failed for dagId=${dagId}`, { error: message });
          eventLog.append("dag_cancel_failed", { dagId, error: message });
          return {
            content: [textContent(message)],
            details: { dagId, error: "cancel_failed" },
          };
        } finally {
          coordinator?.dispose?.();
        }
      }

      // ── unknown action ──
      return { content: [textContent(`Error: unknown action '${action}'. Use 'submit', 'status', or 'cancel'.`)], details: { error: "unknown_action" } };
    },
  });

  pi.registerCommand("acp-doctor", {
    description: "Compatibility alias for /acp runtime doctor",
    async handler(_args, ctx) {
      showAcpDoctor(ctx);
    },
  });

  // ── ACP Hooks policy tools (acp_hooks_policy_get / acp_hooks_policy_set) ──
  if (
    isToolEnabled(toolSettings, "acp_hooks_policy_get") ||
    isToolEnabled(toolSettings, "acp_hooks_policy_set")
  ) {
    registerHooksPolicyTools(pi, { store: hookPolicyStore });
  }

  pi.on("session_shutdown", async () => {
    monitor.stop();
    workerDispatcher?.stop();
    // ── ACP Hooks cleanup ──
    hookTriggers.dispose();
    hookRunner.dispose();
    try { await hookWake?.stop(); } catch { /* ignore */ }
    try { await hookPublisherRef.current?.stop(); } catch { /* ignore */ }
    await sessionMgr.disposeAll();
    for (const adapter of activeAdapters.values()) {
      adapter.dispose();
    }
    activeAdapters.clear();
    eventLog.append("session_shutdown_all");
  });
}

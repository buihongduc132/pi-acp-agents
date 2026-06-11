/**
 * pi-acp-advanced — Extension for pi-acp-agents.
 *
 * Provides multi-agent coordination, task management, async delegation,
 * and mailbox messaging. Requires pi-acp-agents (base) to be loaded first.
 *
 * R-SP1: Fails loudly but never crashes when base is missing.
 * Filesystem-first: reads base's runtime dir, creates own store instances.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  loadConfig,
  ensureRuntimeDir,
  createAdapter,
  AcpTaskStore,
  MailboxManager,
  GovernanceStore,
  WorkerStore,
  AcpEventLog,
  type AcpConfig,
  type AcpRuntimePaths,
  type AcpAdapterOptions,
} from "pi-acp-agents";

// ── Helpers ─────────────────────────────────────────────────────────────────

function textContent(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ── Base detection (R-SP1) ──────────────────────────────────────────────────

interface BaseCheck {
  ok: boolean;
  runtimeDir?: string;
  configFile?: string;
  warning?: string;
}

function checkBaseLoaded(): BaseCheck {
  const runtimeDir = join(homedir(), ".pi", "acp-agents");
  const configFile = join(runtimeDir, "config.json");

  if (!existsSync(runtimeDir)) {
    return {
      ok: false,
      warning: `⚠️ pi-acp-advanced requires pi-acp-agents to be installed and loaded first. Runtime dir missing: ${runtimeDir}`,
    };
  }

  if (!existsSync(configFile)) {
    return {
      ok: false,
      warning: `⚠️ pi-acp-advanced requires pi-acp-agents config at ${configFile}. Fix: Add "npm:pi-acp-agents" to settings.json BEFORE "npm:pi-acp-advanced".`,
    };
  }

  return { ok: true, runtimeDir, configFile };
}

// ── Extension activation ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const baseCheck = checkBaseLoaded();

  if (!baseCheck.ok) {
    // R-SP1: Cannot use pi.ui here (ExtensionAPI has no .ui).
    // Warn via console (visible in session output) and register
    // a command so the user can re-check the warning later.
    console.error(baseCheck.warning);
    pi.registerCommand("acp-advanced:status", {
      description: "Check pi-acp-advanced extension status (base package availability)",
      async execute() {
        return baseCheck.warning!;
      },
    });
    return; // graceful exit — no tools registered (R-SP1)
  }

  // Filesystem-first: load own config, create own store instances pointing
  // to the same runtime directory as the base package.
  let config: AcpConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ pi-acp-advanced failed to load config: ${msg}`);
    return;
  }

  const runtimePaths: AcpRuntimePaths = ensureRuntimeDir(config.runtimeDir);

  // Own store instances — same files as base, independent in-memory state
  const taskStore = new AcpTaskStore(runtimePaths.rootDir);
  const mailboxManager = new MailboxManager(runtimePaths.rootDir);
  const governanceStore = new GovernanceStore(runtimePaths.rootDir);
  const workerStore = new WorkerStore(runtimePaths.rootDir);
  const eventLog = new AcpEventLog(runtimePaths.rootDir);

  governanceStore.setModelPolicy(config.modelPolicy ?? {});

  // ── Extension tools ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "acp_task_create",
    label: "ACP Task Create",
    description: "Create a persistent ACP task in the runtime task store.",
    promptSnippet: "acp_task_create — create ACP task",
    parameters: Type.Object({
      subject: Type.String({ description: "Short task subject" }),
      description: Type.Optional(Type.String({ description: "Longer task details" })),
      deps: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on" })),
      assignee: Type.Optional(Type.String({ description: "Optional agent assignee" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const task = taskStore.create({
          subject: params.subject,
          description: params.description,
          deps: params.deps ?? [],
          assignee: params.assignee,
        });
        eventLog.append("task_created", { taskId: task.id, subject: task.subject });
        return { content: [textContent(formatJson(task))], details: task };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Task create failed: ${msg}`)], details: { ok: false } };
      }
    },
  });

  pi.registerTool({
    name: "acp_task_update",
    label: "ACP Task Update",
    description: "Update ACP task properties: assign, status, deps, clear, priority.",
    promptSnippet: "acp_task_update — update ACP task",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID" }),
      status: Type.Optional(Type.String({ description: "New status: pending, in_progress, completed, deleted" })),
      assignee: Type.Optional(Type.String({ description: "Assignee name; omit to clear" })),
      result: Type.Optional(Type.String({ description: "Optional task result text" })),
      dep_id: Type.Optional(Type.String({ description: "Dependency task ID to add or remove" })),
      dep_action: Type.Optional(Type.String({ description: "add or remove dependency" })),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.dep_id && params.dep_action === "add") {
          const task = taskStore.addDependency(params.task_id, params.dep_id);
          eventLog.append("task_dep_add", { taskId: params.task_id, depId: params.dep_id });
          return { content: [textContent(formatJson(task))], details: task };
        }
        if (params.dep_id && params.dep_action === "remove") {
          const task = taskStore.removeDependency(params.task_id, params.dep_id);
          eventLog.append("task_dep_rm", { taskId: params.task_id, depId: params.dep_id });
          return { content: [textContent(formatJson(task))], details: task };
        }
        const task = taskStore.update(params.task_id, {
          status: params.status,
          assignee: params.assignee,
          result: params.result,
        });
        eventLog.append("task_updated", { taskId: params.task_id, status: params.status });
        return { content: [textContent(formatJson(task))], details: task };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Task update failed: ${msg}`)], details: { ok: false } };
      }
    },
  });

  pi.registerTool({
    name: "acp_message",
    label: "ACP Message",
    description: "Send/receive mailbox messages between ACP agents.",
    promptSnippet: "acp_message — send/list ACP messages",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name or * for broadcast" }),
      message: Type.Optional(Type.String({ description: "Message body" })),
      kind: Type.Optional(Type.String({ description: "dm, steer, or broadcast" })),
      from: Type.Optional(Type.String({ description: "Sender identity" })),
      action: Type.Optional(Type.String({ description: "send or list (default: send if message provided, else list)" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const action = params.action ?? (params.message ? "send" : "list");
        if (action === "send") {
          if (!params.message) {
            return { content: [textContent("Message body is required for send action.")], details: { ok: false } };
          }
          const msg = mailboxManager.send({
            to: params.to,
            message: params.message,
            kind: (params.kind as "dm" | "steer" | "broadcast") ?? "dm",
            from: params.from ?? "pi",
          });
          eventLog.append("message_sent", { to: params.to, kind: msg.kind });
          return { content: [textContent(formatJson(msg))], details: msg };
        }
        const messages = mailboxManager.listFor(params.to);
        return { content: [textContent(formatJson(messages))], details: { count: messages.length, messages } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Message failed: ${msg}`)], details: { ok: false } };
      }
    },
  });

  pi.registerTool({
    name: "acp_compare",
    label: "ACP Compare",
    description: "Get responses from multiple ACP agents and compare them.",
    promptSnippet: "acp_compare — compare ACP agent responses",
    parameters: Type.Object({
      message: Type.String({ description: "Prompt to compare across agents" }),
      agents: Type.Optional(Type.Array(Type.String(), { description: "Agent names. Default: all configured agents" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const agentNames = params.agents ?? Object.keys(config.agent_servers);
        if (agentNames.length < 2) {
          return { content: [textContent("Need at least 2 agents to compare.")], details: { ok: false } };
        }

        const results = await Promise.allSettled(
          agentNames.map(async (agentName) => {
            const agentCfg = config.agent_servers[agentName];
            if (!agentCfg) return { agent: agentName, text: "", error: `Agent "${agentName}" not found` };
            const adapter = createAdapter(agentName, agentCfg, { cwd: ctx.cwd } as AcpAdapterOptions);
            try {
              await adapter.initialize();
              const result = await adapter.prompt(params.message);
              adapter.dispose();
              return { agent: agentName, text: result.text, sessionId: result.sessionId, stopReason: result.stopReason };
            } catch (err: unknown) {
              adapter.dispose();
              const msg = err instanceof Error ? err.message : String(err);
              return { agent: agentName, text: "", error: msg };
            }
          }),
        );

        const comparison = results.map((r) => (r.status === "fulfilled" ? r.value : { agent: "unknown", text: "", error: String(r.reason) }));
        eventLog.append("compare", { agents: agentNames, count: agentNames.length });
        return { content: [textContent(formatJson(comparison))], details: { comparison } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Compare failed: ${msg}`)], details: { ok: false } };
      }
    },
  });
}

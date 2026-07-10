/**
 * pi-acp-advanced — Extension for pi-acp-agents.
 *
 * Provides multi-agent coordination, task management, async delegation,
 * and mailbox messaging. Requires pi-acp-agents (base) to be loaded first.
 *
 * Tool surface aligns with the base package's consolidated ACP tool surface:
 * registers `acp_task` (action: create|update) and `acp_msg` (action: send|list)
 * — the SAME unified names the base package registers — instead of the legacy
 * `acp_task_create` / `acp_task_update` / `acp_message` names that were removed
 * during the 11 → 7 consolidation. This prevents duplicate-name proliferation
 * when both packages are loaded together.
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

  // Unified acp_task — consolidates acp_task_create + acp_task_update.
  // Uses the SAME tool name as the base package's acp_task so that when both
  // packages are loaded there is no duplicate-name proliferation. If the base
  // package already registers acp_task, this extension's registration is a
  // no-op override (same name). Delegates to the shared AcpTaskStore.
  pi.registerTool({
    name: "acp_task",
    label: "ACP Task (advanced)",
    description:
      "Create or update a persistent ACP task. action:'create' adds a new task; action:'update' modifies an existing one (status, assignee, deps, result).",
    promptSnippet: "acp_task — create/update ACP tasks (advanced extension)",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "create or update (default: create if no task_id, else update)",
        }),
      ),
      subject: Type.Optional(Type.String({ description: "Task subject (required for create)" })),
      description: Type.Optional(Type.String({ description: "Longer task details" })),
      deps: Type.Optional(
        Type.Array(Type.String(), { description: "Task IDs this depends on (create)" }),
      ),
      task_id: Type.Optional(Type.String({ description: "Task ID (required for update)" })),
      status: Type.Optional(
        Type.String({
          description: "New status: pending, in_progress, completed, deleted",
        }),
      ),
      assignee: Type.Optional(Type.String({ description: "Optional agent assignee" })),
      result: Type.Optional(Type.String({ description: "Optional task result text" })),
      dep_id: Type.Optional(
        Type.String({ description: "Dependency task ID to add or remove" }),
      ),
      dep_action: Type.Optional(
        Type.String({ description: "add or remove dependency" }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const action = params.action ?? (params.task_id ? "update" : "create");
        if (action === "create") {
          const task = taskStore.create({
            subject: params.subject ?? "",
            description: params.description,
            deps: params.deps ?? [],
            assignee: params.assignee,
          });
          eventLog.append("task_created", { taskId: task.id, subject: task.subject });
          return { content: [textContent(formatJson(task))], details: task };
        }
        if (action === "update") {
          if (!params.task_id) {
            return {
              content: [textContent("task_id is required for update action.")],
              details: { ok: false, error: "missing_task_id" },
            };
          }
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
        }
        return {
          content: [textContent(`Unknown action '${action}'. Use 'create' or 'update'.`)],
          details: { ok: false, error: "unknown_action" },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Task failed: ${msg}`)], details: { ok: false } };
      }
    },
  });

  // Unified acp_msg — consolidates acp_message send+list.
  // Uses the SAME tool name as the base package's acp_msg so there is no
  // duplicate-name proliferation when both packages are loaded. Delegates to
  // the shared MailboxManager.
  pi.registerTool({
    name: "acp_msg",
    label: "ACP Message (advanced)",
    description:
      "Send or list mailbox messages between ACP agents. action:'send' sends a message; action:'list' returns the inbox for a recipient.",
    promptSnippet: "acp_msg — send/list ACP messages (advanced extension)",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "send or list (default: send if message provided, else list)",
        }),
      ),
      to: Type.String({ description: "Recipient agent name or * for broadcast" }),
      message: Type.Optional(Type.String({ description: "Message body (required for send)" })),
      kind: Type.Optional(Type.String({ description: "dm, steer, or broadcast" })),
      from: Type.Optional(Type.String({ description: "Sender identity" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const action = params.action ?? (params.message ? "send" : "list");
        if (action === "send") {
          if (!params.message) {
            return {
              content: [textContent("Message body is required for send action.")],
              details: { ok: false },
            };
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
        if (action === "list") {
          const messages = mailboxManager.listFor(params.to);
          return {
            content: [textContent(formatJson(messages))],
            details: { count: messages.length, messages },
          };
        }
        return {
          content: [textContent(`Unknown action '${action}'. Use 'send' or 'list'.`)],
          details: { ok: false, error: "unknown_action" },
        };
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
      agents: Type.Optional(
        Type.Array(Type.String(), { description: "Agent names. Default: all configured agents" }),
      ),
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

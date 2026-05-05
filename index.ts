/**
 * pi-acp-agents — Pi extension entry point
 *
 * Registers ACP agent tools and commands with pi.
 * All tool execute calls are wrapped through the circuit breaker.
 *
 * Tools: acp_prompt, acp_status, acp_session_new
 * Commands: /acp-config
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { type AcpWidgetState, createAcpWidget } from "./src/acp-widget.js";
import { createAdapter } from "./src/adapter-factory.js";
import { AcpCircuitBreaker } from "./src/core/circuit-breaker.js";
import { loadConfig } from "./src/config/config.js";
import {
	type AgentResult as _AgentResult,
	type ComparisonResult as _ComparisonResult,
	AgentCoordinator,
} from "./src/coordination/coordinator.js";
import { HealthMonitor } from "./src/core/health-monitor.js";
import { createFileLogger } from "./src/logger.js";
import { SessionManager } from "./src/core/session-manager.js";
import type {
	AcpConfig,
	AcpPromptResult,
	AcpSessionHandle,
} from "./src/config/types.js";

/** Details returned by acp_prompt */
interface AcpPromptDetails {
	sessionId: string;
	stopReason: string;
	agent: string;
}

/** Details returned by acp_status */
interface AcpStatusDetails {
	circuitBreaker: string;
	agentCount: number;
	sessionCount: number;
}

/** Details returned by acp_session_new */
interface AcpSessionNewDetails {
	sessionId: string;
	agent: string;
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

export default function (pi: ExtensionAPI) {
	// ── State ──────────────────────────────────────────────────────────
	const sessionMgr = new SessionManager();
	const activeAdapters = new Map<string, ReturnType<typeof createAdapter>>();
	const busySessions = new Map<string, boolean>(); // For FIX-B8: mutex per session
	let config: AcpConfig = loadConfig();
	let widgetRegistered = false;

	const logsDir =
		config.logsDir ?? join(homedir(), ".pi", "acp-agents", "logs");
	const logger = createFileLogger(logsDir);

	const cb = new AcpCircuitBreaker(
		config.circuitBreakerMaxFailures ?? 3,
		config.circuitBreakerResetMs ?? 60_000,
		config.stallTimeoutMs ?? 300_000, // 5 minutes default
	);

	const monitor = new HealthMonitor({
		intervalMs: config.healthCheckIntervalMs ?? 30_000,
		staleTimeoutMs: config.staleTimeoutMs ?? 900_000,
		onStale(sessionId: string) {
			logger.info("session stale, disposing", { sessionId });
			sessionMgr.remove(sessionId);
			activeAdapters.delete(sessionId);
		},
	});
	monitor.start();

	// ── Widget ────────────────────────────────────────────────────────
	const getWidgetState = (): AcpWidgetState => ({
		sessions: sessionMgr.list().map((s) => ({
			sessionId: s.sessionId,
			agentName: s.agentName,
			cwd: s.cwd,
			status: s.disposed
				? ("error" as const)
				: Date.now() - s.lastActivityAt.getTime() >
						(config.staleTimeoutMs ?? 900_000)
					? ("stale" as const)
					: ("idle" as const),
			lastActivityAt: s.lastActivityAt,
			createdAt: s.createdAt,
			model: (s as any).model as string | undefined,
		})),
		circuitBreakerState: cb.state as "closed" | "open" | "half-open",
		configuredAgentNames: Object.keys(config.agents),
		defaultAgent: config.defaultAgent,
	});

	const widgetFactory = createAcpWidget({ getState: getWidgetState });

	/** Register widget with pi TUI. Safe to call multiple times. */
	function ensureWidget(ctx: { ui: { setWidget: Function } }) {
		if (widgetRegistered) return;
		try {
			ctx.ui.setWidget("pi-acp-agents", widgetFactory);
			widgetRegistered = true;
		} catch {
			// TUI not available (non-interactive mode)
		}
	}

	/** Refresh widget after state change. */
	function refreshWidget(ctx: { ui: { setWidget: Function } }) {
		if (!widgetRegistered) {
			ensureWidget(ctx);
			return;
		}
		try {
			ctx.ui.setWidget("pi-acp-agents", widgetFactory);
		} catch {
			// TUI not available
		}
	}

	// ── Helpers ────────────────────────────────────────────────────────

	function makeSessionHandle(
		sessionId: string,
		agentName: string,
		cwd: string,
		adapter: ReturnType<typeof createAdapter>,
	): AcpSessionHandle {
		const now = new Date();
		const handle: AcpSessionHandle = {
			sessionId,
			agentName,
			cwd,
			createdAt: now,
			lastActivityAt: now,
			accumulatedText: "",
			disposed: false,
			dispose: async () => {
				handle.disposed = true;
				adapter.dispose();
				activeAdapters.delete(sessionId);
			},
		};
		sessionMgr.add(handle);
		monitor.register(handle);
		activeAdapters.set(sessionId, adapter);
		return handle;
	}

	/** Circuit-breaker-wrapped executor. NEVER throws. */
	async function safeExecute<T>(
		fn: () => Promise<T>,
		label: string,
	): Promise<
		{ ok: true; value: T } | { ok: false; error: string; circuitOpen?: boolean }
	> {
		try {
			const value = await cb.execute(fn);
			return { ok: true, value };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			const circuitOpen =
				err instanceof Error && err.name === "CircuitOpenError";
			logger.error(`error in ${label}`, { error: msg });
			return { ok: false, error: msg, circuitOpen };
		}
	}

	// ── Tool: acp_prompt ────────────────────────────────────────────────
	pi.registerTool({
		name: "acp_prompt",
		label: "ACP Prompt",
		description:
			"Send a prompt to an ACP-compatible agent (e.g., Gemini CLI). " +
			"Returns the agent's text response. Creates a new session if needed.",
		promptSnippet:
			"acp_prompt — send a prompt to an ACP agent and get the response",
		parameters: Type.Object({
			message: Type.String({
				description: "The message/prompt to send to the agent",
			}),
			agent: Type.Optional(
				Type.String({
					description:
						"Agent name from config. Default: use defaultAgent setting",
				}),
			),
			session_id: Type.Optional(
				Type.String({ description: "Existing session ID to reuse" }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the agent" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentName =
				params.agent ?? config.defaultAgent ?? Object.keys(config.agents)[0];
			const agentCfg = config.agents[agentName];

			if (!agentCfg) {
				return {
					content: [
						textContent(
							`Agent "${agentName}" not found. Available: ${Object.keys(config.agents).join(", ") || "none"}`,
						),
					],
					details: {
						agent: agentName,
						error: "not found",
					} as unknown as AcpPromptDetails,
				};
			}

			const result = await safeExecute(async () => {
				// Reuse existing adapter by session_id
				if (params.session_id && activeAdapters.has(params.session_id)) {
					const handle = sessionMgr.get(params.session_id);
					// FIX-B7: Check if session disposed
					if (!handle || handle.disposed) {
						return {
							content: [
								textContent(`Session "${params.session_id}" not found or disposed.`),
							],
							details: undefined,
						};
					}
					// FIX-B8: Check if session is busy
					if (busySessions.get(params.session_id)) {
						return {
							content: [
								textContent(`Session "${params.session_id}" is busy. Try again later.`),
							],
							details: undefined,
						};
					}
					busySessions.set(params.session_id, true);
					try {
						const adapter = activeAdapters.get(params.session_id)!;
						const promptResult = (await adapter.prompt(
						params.message,
						)) as AcpPromptResult;

						// Touch session activity
						if (handle) {
							handle.lastActivityAt = new Date();
							handle.accumulatedText += promptResult.text;
						}

						return promptResult;
					} finally {
						busySessions.delete(params.session_id);
					}
				}

				// Create fresh adapter + session
				const adapter = createAdapter(
					agentName,
					agentCfg,
					config,
					params.cwd ?? ctx.cwd,
				);
				try {
					await adapter.spawn();
					await adapter.initialize();
					const sessionId = await adapter.newSession(params.cwd ?? ctx.cwd);

					const promptResult = (await adapter.prompt(
						params.message,
					)) as AcpPromptResult;

					makeSessionHandle(sessionId, agentName, params.cwd ?? ctx.cwd, adapter);

					return { ...promptResult, sessionId };
				} catch (err) {
					await adapter.dispose().catch(() => {});
					throw err;
				}
			}, `acp_prompt(${agentName})`);

			if (result.ok) {
				const r = result.value;
				refreshWidget(ctx);
				return {
					content: [textContent(r.text || "(no response)")],
					details: {
						sessionId: r.sessionId,
						stopReason: r.stopReason,
						agent: agentName,
					} satisfies AcpPromptDetails,
				};
			}

			const prefix = result.circuitOpen
				? "Circuit breaker open — too many failures. Retry later.\n"
				: "";
			refreshWidget(ctx);
			return {
				content: [
					textContent(`${prefix}ACP error (${agentName}): ${result.error}`),
				],
				details: {
					sessionId: "",
					stopReason: "error",
					agent: agentName,
				} satisfies AcpPromptDetails,
			};
		},
	});

	// ── Tool: acp_status ────────────────────────────────────────────────
	pi.registerTool({
		name: "acp_status",
		label: "ACP Status",
		description:
			"Check the status of ACP agent connections. Shows configured agents and active sessions.",
		promptSnippet: "acp_status — check ACP agent and session status",
		parameters: Type.Object({
			session_id: Type.Optional(
				Type.String({ description: "Specific session ID to inspect" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Reload config on each status call
			config = loadConfig();

			if (params.session_id) {
				const handle = sessionMgr.get(params.session_id);
				if (!handle) {
					return {
						content: [textContent(`Session "${params.session_id}" not found.`)],
						details: {
							circuitBreaker: cb.state,
							agentCount: 0,
							sessionCount: sessionMgr.size,
						} satisfies AcpStatusDetails,
					};
				}
				return {
					content: [
						textContent(
							`Session: ${handle.sessionId}\n` +
								`Agent:   ${handle.agentName}\n` +
								`CWD:     ${handle.cwd}\n` +
								`Created: ${handle.createdAt.toISOString()}\n` +
								`Active:  ${handle.lastActivityAt.toISOString()}\n` +
								`Disposed: ${handle.disposed}`,
						),
					],
					details: {
						circuitBreaker: cb.state,
						agentCount: Object.keys(config.agents).length,
						sessionCount: sessionMgr.size,
					} satisfies AcpStatusDetails,
				};
			}

			const agentLines = Object.entries(config.agents)
				.map(
					([name, cfg]) =>
						`  ${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")}`,
				)
				.join("\n");

			const sessionLines = sessionMgr
				.list()
				.map((s) => `  ${s.sessionId} (${s.agentName}) — ${s.cwd}`)
				.join("\n");

			refreshWidget(_ctx);
			return {
				content: [
					textContent(
						`ACP Agents Status\n` +
							`─────────────────\n` +
							`Circuit Breaker: ${cb.state}\n` +
							`Agents: ${Object.keys(config.agents).length} configured\n` +
							`Default: ${config.defaultAgent ?? "none"}\n\n` +
							`Agents:\n${agentLines || "  (none)"}\n\n` +
							`Active Sessions (${sessionMgr.size}):\n${sessionLines || "  (none)"}`,
					),
				],
				details: {
					circuitBreaker: cb.state,
					agentCount: Object.keys(config.agents).length,
					sessionCount: sessionMgr.size,
				} satisfies AcpStatusDetails,
			};
		},
	});

	// ── Tool: acp_session_new ───────────────────────────────────────────
	pi.registerTool({
		name: "acp_session_new",
		label: "ACP New Session",
		description:
			"Create a new ACP agent session. Returns session ID for use with acp_prompt.",
		promptSnippet: "acp_session_new — create a new ACP session",
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({
					description: "Agent name. Default: configured default agent",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentName =
				params.agent ?? config.defaultAgent ?? Object.keys(config.agents)[0];
			const agentCfg = config.agents[agentName];

			if (!agentCfg) {
				return {
					content: [
						textContent(
							`Agent "${agentName}" not found. Available: ${Object.keys(config.agents).join(", ") || "none"}`,
						),
					],
					details: {
						sessionId: "",
						agent: agentName,
					} satisfies AcpSessionNewDetails,
				};
			}

			const result = await safeExecute(async () => {
				const adapter = createAdapter(
					agentName,
					agentCfg,
					config,
					params.cwd ?? ctx.cwd,
				);
				try {
					await adapter.spawn();
					await adapter.initialize();
					const sessionId = await adapter.newSession(params.cwd ?? ctx.cwd);

					makeSessionHandle(sessionId, agentName, params.cwd ?? ctx.cwd, adapter);

					return sessionId;
				} catch (err) {
					await adapter.dispose().catch(() => {});
					throw err;
				}
			}, `acp_session_new(${agentName})`);

			if (result.ok) {
				refreshWidget(ctx);
				return {
					content: [
						textContent(
							`Created session ${result.value} with agent "${agentName}"`,
						),
					],
					details: {
						sessionId: result.value,
						agent: agentName,
					} satisfies AcpSessionNewDetails,
				};
			}

			refreshWidget(ctx);
			return {
				content: [textContent(`Failed to create session: ${result.error}`)],
				details: {
					sessionId: "",
					agent: agentName,
				} satisfies AcpSessionNewDetails,
			};
		},
	});

	// ── Tool: acp_session_load (Level 2) ─────────────────────────────────
	pi.registerTool({
		name: "acp_session_load",
		label: "ACP Load Session",
		description:
			"Load an existing ACP agent session by ID to resume a conversation.",
		promptSnippet: "acp_session_load — load an existing ACP session",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID to load" }),
			agent: Type.Optional(
				Type.String({ description: "Agent name from config" }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the agent" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentName =
				params.agent ?? config.defaultAgent ?? Object.keys(config.agents)[0];
			const agentCfg = config.agents[agentName];

			if (!agentCfg) {
				return {
					content: [
						textContent(
							`Agent "${agentName}" not found. Available: ${Object.keys(config.agents).join(", ") || "none"}`,
						),
					],
				};
			}

			const result = await safeExecute(async () => {
				// Reuse existing adapter if already active
				if (activeAdapters.has(params.session_id)) {
					const adapter = activeAdapters.get(params.session_id)!;
					await adapter.loadSession(params.session_id);
					return params.session_id;
				}

				// Create new adapter and load session
				const adapter = createAdapter(
					agentName,
					agentCfg,
					config,
					params.cwd ?? ctx.cwd,
				);
				await adapter.spawn();
				await adapter.initialize();
				const sessionId = await adapter.loadSession(params.session_id);

				makeSessionHandle(sessionId, agentName, params.cwd ?? ctx.cwd, adapter);
				return sessionId;
			}, `acp_session_load(${agentName})`);

			if (result.ok) {
				return {
					content: [
						textContent(
							`Loaded session ${result.value} with agent "${agentName}"`,
						),
					],
					details: { sessionId: result.value, agent: agentName },
				};
			}

			return {
				content: [textContent(`Failed to load session: ${result.error}`)],
				details: undefined,
			};
		},
	});

	// ── Tool: acp_session_set_model (Level 2) ─────────────────────────────
	pi.registerTool({
		name: "acp_session_set_model",
		label: "ACP Set Model",
		description: "Change the model for an active ACP agent session.",
		promptSnippet: "acp_session_set_model — change ACP session model",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID" }),
			model_id: Type.String({
				description: "Model ID (e.g., gemini-2.5-pro, gemini-2.5-flash)",
			}),
		}),
		async execute(_toolCallId, params) {
			const handle = sessionMgr.get(params.session_id);
			// FIX-B7: Check if session exists or disposed
			if (!handle || handle.disposed) {
				return {
					content: [
						textContent(
							`Session "${params.session_id}" not found or disposed. Use acp_session_new or acp_prompt first.`,
						),
					],
				};
			}

			const result = await safeExecute(async () => {
				const adapter = activeAdapters.get(params.session_id)!;
				await adapter.setModel(params.model_id);

				// Update handle
				const handle = sessionMgr.get(params.session_id);
				if (handle) {
					(handle as any).model = params.model_id;
					handle.lastActivityAt = new Date();
				}

				return params.model_id;
			}, `acp_session_set_model`);

			if (result.ok) {
				return {
					content: [
						textContent(
							`Model set to "${result.value}" for session ${params.session_id}`,
						),
					],
					details: { sessionId: params.session_id, modelId: result.value },
				};
			}

			return {
				details: undefined,
				content: [textContent(`Failed to set model: ${result.error}`)],
			};
		},
	});

	// ── Tool: acp_session_set_mode (Level 2) ──────────────────────────────
	pi.registerTool({
		name: "acp_session_set_mode",
		label: "ACP Set Mode",
		description:
			"Change the mode (thinking level) for an active ACP agent session.",
		promptSnippet: "acp_session_set_mode — change ACP session mode",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID" }),
			mode_id: Type.String({
				description: "Mode ID (e.g., default, autoEdit, yolo, plan)",
			}),
		}),
		async execute(_toolCallId, params) {
			const handle = sessionMgr.get(params.session_id);
			// FIX-B7: Check if session exists or disposed
			if (!handle || handle.disposed) {
				return {
					content: [
						textContent(
							`Session "${params.session_id}" not found or disposed. Use acp_session_new or acp_prompt first.`,
						),
					],
				};
			}

			const result = await safeExecute(async () => {
				const adapter = activeAdapters.get(params.session_id)!;
				await adapter.setMode(params.mode_id);

				const handle = sessionMgr.get(params.session_id);
				if (handle) handle.lastActivityAt = new Date();

				return params.mode_id;
			}, `acp_session_set_mode`);

			if (result.ok) {
				return {
					content: [
						textContent(
							`Mode set to "${result.value}" for session ${params.session_id}`,
						),
					],
					details: { sessionId: params.session_id, modeId: result.value },
				};
			}

			return {
				content: [textContent(`Failed to set mode: ${result.error}`)],
				details: undefined,
			};
		},
	});

	// ── Tool: acp_cancel (Level 2) ────────────────────────────────────────
	pi.registerTool({
		name: "acp_cancel",
		label: "ACP Cancel",
		description: "Cancel an ongoing prompt on an ACP agent session.",
		promptSnippet: "acp_cancel — cancel ongoing ACP prompt",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID to cancel" }),
		}),
		async execute(_toolCallId, params) {
			const handle = sessionMgr.get(params.session_id);
			// FIX-B7: Check if session exists or disposed
			if (!handle || handle.disposed) {
				return {
					content: [textContent(`Session "${params.session_id}" not found or disposed.`)],
					details: undefined,
				};
			}

			const result = await safeExecute(async () => {
				const adapter = activeAdapters.get(params.session_id)!;
				await adapter.cancel();

				const handle = sessionMgr.get(params.session_id);
				if (handle) handle.lastActivityAt = new Date();

				return true;
			}, `acp_cancel`);

			if (result.ok) {
				return {
					content: [
						textContent(`Cancelled prompt on session ${params.session_id}`),
					],
					details: { sessionId: params.session_id, cancelled: true },
				};
			}

			return {
				content: [textContent(`Failed to cancel: ${result.error}`)],
				details: undefined,
			};
		},
	});

	// ── Tool: acp_delegate (Level 3) ────────────────────────────────────
	pi.registerTool({
		name: "acp_delegate",
		label: "ACP Delegate",
		description:
			"Delegate a task to a specific ACP agent and get its response. " +
			"Creates a short-lived session that is disposed after use.",
		promptSnippet: "acp_delegate — delegate a task to an ACP agent",
		parameters: Type.Object({
			message: Type.String({ description: "Task to delegate to the agent" }),
			agent: Type.Optional(
				Type.String({
					description: "Agent name from config. Default: use defaultAgent",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentName =
				params.agent ?? config.defaultAgent ?? Object.keys(config.agents)[0];

			if (!config.agents[agentName]) {
				return {
					content: [
						textContent(
							`Agent "${agentName}" not found. Available: ${Object.keys(config.agents).join(", ") || "none"}`,
						),
					],
					details: { agent: agentName, error: "not found" },
				};
			}

			const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd);
			const result = await safeExecute(
				() =>
					coordinator.delegate(
						agentName,
						params.message,
						params.cwd ?? ctx.cwd,
					),
				`acp_delegate(${agentName})`,
			);

			if (result.ok) {
				const r = result.value;
				return {
					content: [textContent(r.text || "(no response)")],
					details: {
						agent: agentName,
						sessionId: r.sessionId,
						stopReason: r.stopReason,
					},
				};
			}

			return {
				content: [
					textContent(`Delegate failed (${agentName}): ${result.error}`),
				],
				details: { agent: agentName, error: result.error },
			};
		},
	});

	// ── Tool: acp_broadcast (Level 3) ─────────────────────────────────────
	pi.registerTool({
		name: "acp_broadcast",
		label: "ACP Broadcast",
		description:
			"Send the same prompt to multiple ACP agents in parallel. " +
			"Returns each agent's response. Individual failures don't affect others.",
		promptSnippet: "acp_broadcast — broadcast to multiple ACP agents",
		parameters: Type.Object({
			message: Type.String({ description: "Prompt to send to all agents" }),
			agents: Type.Optional(
				Type.Array(Type.String(), {
					description: "Agent names. Default: all configured agents",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentNames = params.agents ?? Object.keys(config.agents);
			if (agentNames.length === 0) {
				return {
					content: [textContent("No agents configured or specified.")],
				};
			}

			const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd);
			const results = await coordinator.broadcast(
				agentNames,
				params.message,
				params.cwd ?? ctx.cwd,
			);

			const lines = results.map((r) => {
				if (r.error) {
					return `── ${r.agent} ──\n(ERROR: ${r.error})`;
				}
				return `── ${r.agent} ──\n${r.text}`;
			});

			return {
				content: [textContent(`Broadcast results:\n\n${lines.join("\n\n")}`)],
				details: { results },
			};
		},
	});

	// ── Tool: acp_compare (Level 3) ───────────────────────────────────────
	pi.registerTool({
		name: "acp_compare",
		label: "ACP Compare",
		description:
			"Get responses from multiple ACP agents and compare them. " +
			"Returns a structured comparison of all responses.",
		promptSnippet: "acp_compare — compare responses from multiple ACP agents",
		parameters: Type.Object({
			message: Type.String({ description: "Prompt to compare across agents" }),
			agents: Type.Optional(
				Type.Array(Type.String(), {
					description: "Agent names. Default: all configured agents",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentNames = params.agents ?? Object.keys(config.agents);
			if (agentNames.length === 0) {
				return {
					content: [textContent("No agents configured or specified.")],
				};
			}

			const coordinator = new AgentCoordinator(config, params.cwd ?? ctx.cwd);
			const comparison = await coordinator.compare(
				agentNames,
				params.message,
				params.cwd ?? ctx.cwd,
			);

			const lines = comparison.responses.map((r) => {
				if (r.error) {
					return (
						`| ${r.agent.padEnd(20)} | ERROR: ${r.error}`.padEnd(104) + " |"
					);
				}
				return `| ${r.agent.padEnd(20)} | ${r.text.substring(0, 200).padEnd(80)} |`;
			});

			const table =
				`Comparison: "${params.message}"\n` +
				`Timestamp: ${comparison.timestamp}\n\n` +
				`| Agent                | Response                                                                              |\n` +
				`|${"-".repeat(22)}|${"-".repeat(84)}|\n` +
				lines.join("\n");

			return {
				content: [textContent(table)],
				details: { comparison },
			};
		},
	});

	// ── Command: /acp-config ────────────────────────────────────────────
	pi.registerCommand("acp-config", {
		description: "Show current ACP agent configuration",
		async handler(_args, ctx) {
			config = loadConfig();
			const agents = Object.entries(config.agents)
				.map(
					([name, cfg]) =>
						`${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")}`,
				)
				.join("\n");

			refreshWidget(ctx);
			ctx.ui.notify(
				`ACP Agents Config\n${agents}\nDefault: ${config.defaultAgent ?? "none"}\n` +
					`Sessions: ${sessionMgr.size} | Circuit: ${cb.state}`,
				"info",
			);
		},
	});

	// ── Cleanup ─────────────────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		monitor.stop();
		await sessionMgr.disposeAll();
		for (const adapter of activeAdapters.values()) {
			adapter.dispose();
		}
		activeAdapters.clear();
	});
}

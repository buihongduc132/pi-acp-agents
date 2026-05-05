/**
 * Mock ACP agent for testing.
 *
 * Creates in-process streams that simulate an ACP agent.
 * The client connects via ndJsonStream just like it would with a real process.
 *
 * Usage:
 *   const mock = createMockAgent();
 *   const stream = ndJsonStream(mock.input, mock.output);
 *   const conn = new ClientSideConnection(..., stream);
 */
import { ReadableStream, WritableStream } from "node:stream/web";

export interface MockAgentConfig {
  initResponse?: Record<string, unknown>;
  newSessionResponse?: Record<string, unknown>;
  onPrompt?: (text: string, sessionId: string) => string;
  onAuthenticate?: (methodId: string) => void;
}

/**
 * Create a mock ACP agent with in-process streams.
 *
 * Returns:
 *   input: WritableStream — client writes to this (→ agent stdin)
 *   output: ReadableStream — client reads from this (← agent stdout)
 *   sentToAgent: array of messages the client sent
 */
export function createMockAgent(config?: MockAgentConfig) {
  const sentToAgent: Array<{ method: string; params?: unknown; id?: number | string | null }> = [];

  let outputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let pendingId: number | string | null | undefined = undefined;

  // output: ReadableStream — the mock "writes" here, the client reads from here
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller;
    },
  });

  // input: WritableStream — the client writes here, the mock "reads" from here
  let buffer = "";
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      const text = new TextDecoder().decode(chunk);
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.method) {
            sentToAgent.push({ method: msg.method, params: msg.params, id: msg.id });
          }
          handleMessage(msg);
        } catch {
          // ignore parse errors
        }
      }
    },
  });

  function sendToClient(data: unknown) {
    if (!outputController) return;
    outputController.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
  }

  function handleMessage(msg: { id?: number | string | null; method?: string; params?: unknown }) {
    const { id, method, params } = msg;
    if (!method) return;

    switch (method) {
      case "initialize": {
        const result = config?.initResponse ?? {
          protocolVersion: 1,
          agentInfo: { name: "mock-agent", title: "Mock Agent", version: "0.0.1" },
          authMethods: [{ id: "mock-auth", name: "Mock Auth", description: "test" }],
          agentCapabilities: { loadSession: true },
        };
        sendToClient({ jsonrpc: "2.0", id, result });
        break;
      }
      case "authenticate": {
        const methodId = (params as Record<string, unknown>)?.methodId as string;
        config?.onAuthenticate?.(methodId);
        sendToClient({ jsonrpc: "2.0", id, result: {} });
        break;
      }
      case "session/new": {
        const result = config?.newSessionResponse ?? {
          sessionId: `mock-session-${Date.now()}`,
          models: {
            availableModels: [
              { modelId: "mock/model", name: "Mock Model" },
              { modelId: "mock/flash", name: "Mock Flash" },
            ],
            currentModelId: "mock/model",
          },
          modes: {
            currentModeId: "off",
            availableModes: [
              { id: "off", name: "Off" },
              { id: "autoEdit", name: "Auto Edit" },
              { id: "yolo", name: "YOLO" },
              { id: "plan", name: "Plan" },
            ],
          },
        };
        sendToClient({ jsonrpc: "2.0", id, result });
        break;
      }
      case "session/prompt": {
        const p = params as {
          sessionId?: string;
          prompt?: Array<{ type: string; text?: string }>;
        };
        const text = p?.prompt?.[0]?.text ?? "";
        const sessionId = p?.sessionId ?? "unknown";

        // Send notification chunks
        const responseText = config?.onPrompt
          ? config.onPrompt(text, sessionId)
          : `Mock response to: "${text}"`;

        sendToClient({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: responseText },
            },
          },
        });

        // Send the final response
        sendToClient({
          jsonrpc: "2.0",
          id,
          result: { stopReason: "end_turn" },
        });
        break;
      }
      default: {
        sendToClient({ jsonrpc: "2.0", id, result: {} });
      }
    }
  }

  return { input, output, sentToAgent };
}

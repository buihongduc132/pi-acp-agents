import { describe, it, expect } from "vitest";
import { createMockAgent } from "./helpers/mock-acp-server.js";
import { ndJsonStream, ClientSideConnection } from "@agentclientprotocol/sdk";
import type { PromptResponse } from "@agentclientprotocol/sdk";

/**
 * Tests for the ACP client connection logic using mock agent.
 *
 * These tests verify that our AcpClient would work correctly with the ACP SDK.
 * We test the raw ClientSideConnection + mock agent first,
 * then the AcpClient wrapper in separate tests.
 */
describe("client (ACP connection)", () => {
  describe("mock agent integration", () => {
    it("initializes and creates session via mock", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const chunks: string[] = [];

      const conn = new ClientSideConnection(
        (_agent) => ({
          async sessionUpdate(params) {
            const update = params.update as Record<string, unknown>;
            if (update.sessionUpdate === "agent_message_chunk") {
              const content = update.content as Record<string, unknown>;
              if (content.type === "text") {
                chunks.push(content.text as string);
              }
            }
          },
          async requestPermission() {
            return { outcome: { outcome: "approved" } } as any;
          },
        }),
        stream,
      );

      // Initialize
      const initResp = await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      });
      expect(initResp.protocolVersion).toBe(1);
      expect(initResp.agentInfo?.name).toBe("mock-agent");

      // Create session
      const sessionResp = await conn.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });
      expect(sessionResp.sessionId).toBeDefined();
      expect(typeof sessionResp.sessionId).toBe("string");

      // Send prompt
      const promptResp: PromptResponse = await conn.prompt({
        sessionId: sessionResp.sessionId,
        prompt: [{ type: "text", text: "Hello!" }],
      });
      expect(promptResp.stopReason).toBe("end_turn");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toContain("Hello!");
    });

    it("handles custom prompt handler", async () => {
      const mock = createMockAgent({
        onPrompt: (text) => `Custom: ${text.toUpperCase()}`,
      });
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const chunks: string[] = [];
      const conn = new ClientSideConnection(
        (_agent) => ({
          async sessionUpdate(params) {
            const update = params.update as Record<string, unknown>;
            if (update.sessionUpdate === "agent_message_chunk") {
              const content = update.content as Record<string, unknown>;
              if (content.type === "text") chunks.push(content.text as string);
            }
          },
          async requestPermission() {
            return { outcome: { outcome: "approved" } } as any;
          },
        }),
        stream,
      );

      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });

      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
      await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "test input" }],
      });

      expect(chunks.join("")).toBe("Custom: TEST INPUT");
    });

    it("records messages sent to agent", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        (_agent) => ({
          async sessionUpdate() {},
          async requestPermission() {
            return { outcome: { outcome: "approved" } } as any;
          },
        }),
        stream,
      );

      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });

      // Check the mock received the initialize
      expect(mock.sentToAgent.some((m) => m.method === "initialize")).toBe(true);
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { createMockAgent } from "./helpers/mock-acp-server.js";
import { ndJsonStream, ClientSideConnection } from "@agentclientprotocol/sdk";
import type {
  SessionNotification,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

/**
 * Tests for Level 2 ACP client methods: loadSession, setModel, setMode.
 *
 * Uses mock agent that handles additional ACP methods.
 */
describe("Level 2 — client methods", () => {
  /** Helper: create a client connected to a mock agent */
  async function connectToMock(extraConfig?: {
    onPrompt?: (text: string, sid: string) => string;
  }) {
    const mock = createMockAgent(extraConfig);
    const stream = ndJsonStream(mock.input as any, mock.output as any);

    const chunks: string[] = [];

    const conn = new ClientSideConnection(
      () => ({
        sessionUpdate(params: SessionNotification) {
          const update = params.update as Record<string, unknown>;
          if (update.sessionUpdate === "agent_message_chunk") {
            const content = update.content as Record<string, unknown>;
            if (content.type === "text") chunks.push(content.text as string);
          }
        },
        requestPermission() {
          return Promise.resolve({ outcome: "approved" } as unknown as RequestPermissionResponse);
        },
      }),
      stream,
    );

    return { mock, conn, chunks };
  }

  describe("setModel", () => {
    it("sends session/set_model request to agent", async () => {
      const { mock, conn } = await connectToMock();

      // Init + create session
      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      // Set model
      await conn.unstable_setSessionModel({
        sessionId: session.sessionId,
        modelId: "gemini-2.5-flash",
      });

      // Verify the agent received the set_model request
      const setModelMsg = mock.sentToAgent.find(
        (m) => m.method === "session/set_model",
      );
      expect(setModelMsg).toBeDefined();
      expect(setModelMsg!.params).toEqual(
        expect.objectContaining({
          sessionId: session.sessionId,
          modelId: "gemini-2.5-flash",
        }),
      );
    });
  });

  describe("setMode", () => {
    it("sends session/set_mode request to agent", async () => {
      const { mock, conn } = await connectToMock();

      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      await conn.setSessionMode({
        sessionId: session.sessionId,
        modeId: "yolo",
      });

      const setModeMsg = mock.sentToAgent.find(
        (m) => m.method === "session/set_mode",
      );
      expect(setModeMsg).toBeDefined();
      expect(setModeMsg!.params).toEqual(
        expect.objectContaining({
          sessionId: session.sessionId,
          modeId: "yolo",
        }),
      );
    });
  });

  describe("cancel", () => {
    it("sends session/cancel notification to agent", async () => {
      const { mock, conn } = await connectToMock();

      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      await conn.cancel({ sessionId: session.sessionId });

      const cancelMsg = mock.sentToAgent.find(
        (m) => m.method === "session/cancel",
      );
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg!.params).toEqual(
        expect.objectContaining({
          sessionId: session.sessionId,
        }),
      );
    });
  });

  describe("loadSession", () => {
    it("sends session/load request to agent", async () => {
      const { mock, conn } = await connectToMock();

      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });

      // Load an existing session
      const result = await conn.loadSession({
        sessionId: "existing-session-123",
        cwd: "/tmp",
        mcpServers: [],
      });

      const loadMsg = mock.sentToAgent.find(
        (m) => m.method === "session/load",
      );
      expect(loadMsg).toBeDefined();
      expect(loadMsg!.params).toEqual(
        expect.objectContaining({
          sessionId: "existing-session-123",
          cwd: "/tmp",
        }),
      );
    });
  });
});

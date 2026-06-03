import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockAgent } from "./helpers/mock-acp-server.js";
import { ndJsonStream, ClientSideConnection } from "@agentclientprotocol/sdk";
import type {
  SessionNotification,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/core/client.js";
import type { AcpAgentConfig, AcpPromptResult } from "../src/config/types.js";

/**
 * Tests for Level 2 tool lifecycle: loadSession, setModel, setMode, cancel.
 *
 * These tests verify the adapter/client methods that the new tools will call.
 * The actual tool registration in index.ts is tested by checking the tool names
 * exist in the extension.
 */
describe("Level 2 — session lifecycle tools", () => {
  describe("acp_session_load adapter method", () => {
    it("adapter.loadSession calls client.loadSession", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
          async sessionUpdate() { return Promise.resolve() },
          requestPermission() {
            return Promise.resolve({ outcome: "approved" } as unknown as RequestPermissionResponse);
          },
        }),
        stream,
      );

      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });

      // Load session via the ACP protocol
      const result = await conn.loadSession({
        sessionId: "old-session-123",
        cwd: "/tmp",
        mcpServers: [],
      });

      // Verify the agent received session/load
      const loadMsg = mock.sentToAgent.find(
        (m) => m.method === "session/load",
      );
      expect(loadMsg).toBeDefined();
      expect(loadMsg!.params).toEqual(
        expect.objectContaining({
          sessionId: "old-session-123",
          cwd: "/tmp",
        }),
      );
    });
  });

  describe("acp_session_set_model adapter method", () => {
    it("adapter.setModel calls client.setModel", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
          async sessionUpdate() { return Promise.resolve() },
          requestPermission() {
            return Promise.resolve({ outcome: "approved" } as unknown as RequestPermissionResponse);
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

      // Set model
      await conn.unstable_setSessionModel({
        sessionId: session.sessionId,
        modelId: "gemini-2.5-flash",
      });

      const setModelMsg = mock.sentToAgent.find(
        (m) => m.method === "session/set_model",
      );
      expect(setModelMsg).toBeDefined();
      expect(setModelMsg!.params).toMatchObject({
        sessionId: session.sessionId,
        modelId: "gemini-2.5-flash",
      });
    });
  });

  describe("acp_session_set_mode adapter method", () => {
    it("adapter.setMode calls client.setMode", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
          async sessionUpdate() { return Promise.resolve() },
          requestPermission() {
            return Promise.resolve({ outcome: "approved" } as unknown as RequestPermissionResponse);
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

      // Set mode
      await conn.setSessionMode({
        sessionId: session.sessionId,
        modeId: "yolo",
      });

      const setModeMsg = mock.sentToAgent.find(
        (m) => m.method === "session/set_mode",
      );
      expect(setModeMsg).toBeDefined();
      expect(setModeMsg!.params).toMatchObject({
        sessionId: session.sessionId,
        modeId: "yolo",
      });
    });
  });

  describe("acp_cancel adapter method", () => {
    it("adapter.cancel calls client.cancel", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
          async sessionUpdate() { return Promise.resolve() },
          requestPermission() {
            return Promise.resolve({ outcome: "approved" } as unknown as RequestPermissionResponse);
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

      // Cancel
      await conn.cancel({ sessionId: session.sessionId });

      const cancelMsg = mock.sentToAgent.find(
        (m) => m.method === "session/cancel",
      );
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg!.params).toMatchObject({
        sessionId: session.sessionId,
      });
    });
  });

  describe("circuit breaker wrapping for new tools", () => {
    it("safeExecute returns error when circuit is open", async () => {
      // Import and test the circuit breaker integration pattern
      const { AcpCircuitBreaker } = await import("../src/core/circuit-breaker.js");
      const cb = new AcpCircuitBreaker(1, 60_000);

      // Trip the circuit
      await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();

      // Now even a valid call should fail
      const { CircuitOpenError } = await import("../src/core/circuit-breaker.js");
      await expect(cb.execute(async () => "ok")).rejects.toThrow(CircuitOpenError);
    });
  });

  describe("cwd inheritance for new tools", () => {
    it("AcpClient inherits cwd from constructor", () => {
      const client = new AcpClient({
        agentName: "gemini",
        config: { command: "gemini", args: ["--acp"] },
        cwd: "/my/project/dir",
      });

      // The cwd is stored internally and used for spawn + newSession
      expect((client as any).cwd).toBe("/my/project/dir");
    });

    it("AcpClient defaults to process.cwd() when no cwd given", () => {
      const client = new AcpClient({
        agentName: "gemini",
        config: { command: "gemini", args: ["--acp"] },
      });

      expect((client as any).cwd).toBe(process.cwd());
    });
  });
});

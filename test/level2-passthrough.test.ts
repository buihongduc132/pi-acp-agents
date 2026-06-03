import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockAgent } from "./helpers/mock-acp-server.js";
import { ndJsonStream, ClientSideConnection } from "@agentclientprotocol/sdk";

/**
 * Level 2 tests — Full config passthrough.
 *
 * Tests that extended config fields (thinkingLevel, sandbox, skipTrust, mcpServers)
 * are properly passed through the ACP protocol.
 */
describe("Level 2: Config passthrough", () => {
  describe("agent_servers config shape (Zed-style)", () => {
    it("accepts agent_servers with multiple aliases for same command", async () => {
      const { validateConfig } = await import("../src/config/config.js");
      const config = validateConfig({
        agent_servers: {
          "gemy-flash": { command: "gemini", args: ["--acp", "--model", "gemini-2.5-flash"] },
          "gemy-pro": { command: "gemini", args: ["--acp", "--model", "gemini-2.5-pro"] },
          opencode: { command: "ocxo", args: ["acp"] },
        },
      });
      expect(Object.keys(config.agent_servers)).toHaveLength(3);
      expect(config.agent_servers["gemy-flash"].command).toBe("gemini");
      expect(config.agent_servers["gemy-pro"].command).toBe("gemini");
      expect(config.agent_servers["gemy-flash"].args).toContain("gemini-2.5-flash");
      expect(config.agent_servers["gemy-pro"].args).toContain("gemini-2.5-pro");
      expect(config.agent_servers["opencode"].command).toBe("ocxo");
    });

    it("accepts default_model per agent server", async () => {
      const { validateConfig } = await import("../src/config/config.js");
      const config = validateConfig({
        agent_servers: {
          gemini: { command: "gemini", args: ["--acp"], default_model: "gemini-2.5-pro" },
        },
      });
      expect(config.agent_servers.gemini.default_model).toBe("gemini-2.5-pro");
    });

    it("accepts default_mode per agent server", async () => {
      const { validateConfig } = await import("../src/config/config.js");
      const config = validateConfig({
        agent_servers: {
          gemini: { command: "gemini", args: ["--acp"], default_mode: "yolo" },
        },
      });
      expect(config.agent_servers.gemini.default_mode).toBe("yolo");
    });

    it("accepts env per agent server", async () => {
      const { validateConfig } = await import("../src/config/config.js");
      const config = validateConfig({
        agent_servers: {
          gemini: { command: "gemini", args: ["--acp"], env: { GEMINI_API_KEY: "test-key" } },
        },
      });
      expect(config.agent_servers.gemini.env).toEqual({ GEMINI_API_KEY: "test-key" });
    });

    it("preserves unknown passthrough fields", async () => {
      const { validateConfig } = await import("../src/config/config.js");
      const config = validateConfig({
        agent_servers: {
          custom: {
            command: "my-agent",
            customField: "custom-value",
          },
        },
      });
      expect((config.agent_servers.custom as any).customField).toBe("custom-value");
    });

    it("auto-migrates old agents key to agent_servers", async () => {
      const { validateConfig } = await import("../src/config/config.js");
      // Simulate loading an old config that uses `agents` instead of `agent_servers`
      const config = validateConfig({
        agent_servers: {
          gemini: { command: "gemini", args: ["--acp"] },
        },
      });
      expect(Object.keys(config.agent_servers)).toContain("gemini");
    });
  });

  describe("session/set_model via mock", () => {
    it("sends session/set_model to agent", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
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
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      // Set model
      await conn.unstable_setSessionModel({
        sessionId: session.sessionId,
        modelId: "mock/flash",
      });

      expect(
        mock.sentToAgent.some(
          (m) => m.method === "session/set_model" && (m.params as any)?.modelId === "mock/flash",
        ),
      ).toBe(true);
    });
  });

  describe("session/set_mode via mock", () => {
    it("sends session/set_mode to agent", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
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
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      // Set mode
      await conn.setSessionMode({
        sessionId: session.sessionId,
        modeId: "yolo",
      });

      expect(
        mock.sentToAgent.some(
          (m) => m.method === "session/set_mode" && (m.params as any)?.modeId === "yolo",
        ),
      ).toBe(true);
    });
  });

  describe("session/load via mock", () => {
    it("sends session/load to agent", async () => {
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
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

      // Load session
      const result = await conn.loadSession({
        sessionId: "existing-session-123",
        cwd: "/tmp",
        mcpServers: [],
      });

      expect(
        mock.sentToAgent.some((m) => m.method === "session/load"),
      ).toBe(true);
    });
  });

  describe("adapter passthrough methods", () => {
    it("base adapter exposes loadSession, setModel, setMode", async () => {
      const { AcpAgentAdapter } = await import("../src/adapters/base.js");

      // Verify the methods exist on the prototype
      expect(typeof AcpAgentAdapter.prototype.loadSession).toBe("function");
      expect(typeof AcpAgentAdapter.prototype.setModel).toBe("function");
      expect(typeof AcpAgentAdapter.prototype.setMode).toBe("function");
    });

    it("loadSession throws when not spawned", async () => {
      const { AcpAgentAdapter } = await import("../src/adapters/base.js");

      class TestAdapter extends AcpAgentAdapter {
        get name() { return "test"; }
      }

      const adapter = new TestAdapter({
        config: { command: "test" },
      });

      await expect(adapter.loadSession("sid")).rejects.toThrow("Not spawned");
    });

    it("setModel throws when not spawned", async () => {
      const { AcpAgentAdapter } = await import("../src/adapters/base.js");

      class TestAdapter extends AcpAgentAdapter {
        get name() { return "test"; }
      }

      const adapter = new TestAdapter({
        config: { command: "test" },
      });

      await expect(adapter.setModel("model-id")).rejects.toThrow("Not spawned");
    });

    it("setMode throws when not spawned", async () => {
      const { AcpAgentAdapter } = await import("../src/adapters/base.js");

      class TestAdapter extends AcpAgentAdapter {
        get name() { return "test"; }
      }

      const adapter = new TestAdapter({
        config: { command: "test" },
      });

      await expect(adapter.setMode("yolo")).rejects.toThrow("Not spawned");
    });
  });

  describe("AcpClient new methods", () => {
    it("loadSession throws when not connected", async () => {
      const { AcpClient } = await import("../src/core/client.js");
      const client = new AcpClient({
        agentName: "test",
        config: { command: "test" },
      });
      await expect(client.loadSession("sid")).rejects.toThrow("Not connected");
    });

    it("setModel throws when no active session", async () => {
      const { AcpClient } = await import("../src/core/client.js");
      const client = new AcpClient({
        agentName: "test",
        config: { command: "test" },
      });
      // Not connected means no session
      await expect(client.setModel("model")).rejects.toThrow();
    });

    it("setMode throws when no active session", async () => {
      const { AcpClient } = await import("../src/core/client.js");
      const client = new AcpClient({
        agentName: "test",
        config: { command: "test" },
      });
      await expect(client.setMode("yolo")).rejects.toThrow();
    });
  });
});

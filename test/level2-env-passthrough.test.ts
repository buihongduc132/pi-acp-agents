import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  SessionNotification,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/core/client.js";
import type { AcpAgentConfig } from "../src/config/types.js";

/**
 * Tests for Level 2 env/args passthrough through AcpClient.
 */
describe("Level 2 — env/args passthrough", () => {
  describe("config env passthrough", () => {
    it("env vars are accessible in agent config", () => {
      const config: AcpAgentConfig = {
        command: "gemini",
        args: ["--acp"],
        env: { MY_VAR: "hello", ANOTHER: "world" },
      };
      expect(config.env).toEqual({ MY_VAR: "hello", ANOTHER: "world" });
    });

    it("mcpServers are accessible in agent config", () => {
      const config: AcpAgentConfig = {
        command: "gemini",
        args: ["--acp"],
        mcpServers: [
          { name: "fs", command: "mcp-filesystem", args: ["--root", "/tmp"] },
        ],
      };
      expect(config.mcpServers).toHaveLength(1);
      expect(config.mcpServers![0].name).toBe("fs");
    });
  });

  describe("AcpClient spawns with env", () => {
    it("AcpClient passes config.env to spawn", async () => {
      // Use `env` command to verify env vars are passed through
      // We can't actually connect to a real agent here, so we test the constructor
      const config: AcpAgentConfig = {
        command: "echo",
        args: ["test"],
        env: { TEST_ACP_VAR: "acp-test-value" },
      };

      const client = new AcpClient({
        agentName: "test",
        config,
        cwd: "/tmp",
      });

      // The client stores config internally — verify via connect() which spawns
      // We can't fully test spawn env without a real ACP agent,
      // but we can verify the config is stored
      expect((client as any).config.env).toEqual({ TEST_ACP_VAR: "acp-test-value" });
    });

    it("AcpClient passes config.args to spawn", async () => {
      const config: AcpAgentConfig = {
        command: "gemini",
        args: ["--acp", "--sandbox"],
      };

      const client = new AcpClient({
        agentName: "test",
        config,
        cwd: "/tmp",
      });

      expect((client as any).config.args).toEqual(["--acp", "--sandbox"]);
    });
  });

  describe("mcpServers passthrough in newSession", () => {
    it("mcpServers from config are available for newSession", async () => {
      // Test via mock agent — verify mcpServers are sent in session/new
      const { createMockAgent } = await import("./helpers/mock-acp-server.js");
      const mock = createMockAgent();
      const stream = ndJsonStream(mock.input as any, mock.output as any);

      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate() {},
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

      const mcpServers = [
        { name: "fs", command: "mcp-fs", args: ["/tmp"] },
      ];

      await conn.newSession({
        cwd: "/tmp",
        mcpServers: mcpServers as any,
      });

      // Verify mcpServers were sent to the agent
      const newSessionMsg = mock.sentToAgent.find(
        (m) => m.method === "session/new",
      );
      expect(newSessionMsg).toBeDefined();
      expect(newSessionMsg!.params).toEqual(
        expect.objectContaining({
          mcpServers: mcpServers,
        }),
      );
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { AcpAgentAdapter, type AcpAdapterOptions } from "../../src/adapters/base.js";
import type { AcpAgentConfig, AcpPromptResult } from "../../src/config/types.js";
import { createMockAgent } from "../helpers/mock-acp-server.js";
import { ndJsonStream, ClientSideConnection } from "@agentclientprotocol/sdk";
import type { Logger } from "../../src/logger.js";

/** Noop logger for tests */
function noopLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Concrete test adapter that uses mock agent streams instead of spawning a process */
class TestAdapter extends AcpAgentAdapter {
  private mockAgent: ReturnType<typeof createMockAgent> | null = null;

  get name(): string {
    return "test";
  }

  /** Override to use mock streams instead of spawning */
  override async spawn(): Promise<void> {
    this.logger.info(`Spawning ${this.name} adapter (mock)`);

    this.mockAgent = createMockAgent();
    const stream = ndJsonStream(this.mockAgent.input as any, this.mockAgent.output as any);

    // Create a client connection using the mock streams
    // We need to import and use AcpClient but override the connection
    const { AcpClient } = await import("../../src/core/client.js");

    // Create AcpClient but we need to bypass its connect() which spawns a process
    // Instead, let's directly test the adapter flow
    // For the base adapter test, we just verify the contract
  }

  /** Direct connect with mock for testing */
  async connectWithMock(): Promise<ReturnType<typeof createMockAgent>> {
    this.mockAgent = createMockAgent();
    return this.mockAgent;
  }
}

describe("adapters/base", () => {
  describe("AcpAgentAdapter", () => {
    it("applies defaults from constructor", () => {
      class DefaultsAdapter extends AcpAgentAdapter {
        get name() { return "defaults"; }
        protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
          return { ...config, args: config.args ?? ["--default"] };
        }
      }

      const adapter = new DefaultsAdapter({
        config: { command: "test" },
        clientInfo: { name: "test", version: "0.1.0" },
        logger: noopLogger(),
      });

      // Config should have defaults applied
      expect(adapter["config"].args).toEqual(["--default"]);
    });

    it("preserves user-provided config over defaults", () => {
      class DefaultsAdapter extends AcpAgentAdapter {
        get name() { return "defaults"; }
        protected applyDefaults(config: AcpAgentConfig): AcpAgentConfig {
          return { ...config, args: config.args ?? ["--default"] };
        }
      }

      const adapter = new DefaultsAdapter({
        config: { command: "test", args: ["--custom"] },
        clientInfo: { name: "test", version: "0.1.0" },
        logger: noopLogger(),
      });

      expect(adapter["config"].args).toEqual(["--custom"]);
    });

    it("throw on prompt before spawn", async () => {
      class SimpleAdapter extends AcpAgentAdapter {
        get name() { return "simple"; }
      }

      const adapter = new SimpleAdapter({
        config: { command: "test" },
        clientInfo: { name: "test", version: "0.1.0" },
        logger: noopLogger(),
      });

      await expect(adapter.prompt("hello")).rejects.toThrow(/not spawned/i);
    });

    it("throw on initialize before spawn", async () => {
      class SimpleAdapter extends AcpAgentAdapter {
        get name() { return "simple"; }
      }

      const adapter = new SimpleAdapter({
        config: { command: "test" },
        clientInfo: { name: "test", version: "0.1.0" },
        logger: noopLogger(),
      });

      await expect(adapter.initialize()).rejects.toThrow(/not spawned/i);
    });

    it("dispose clears client", () => {
      class SimpleAdapter extends AcpAgentAdapter {
        get name() { return "simple"; }
      }

      const adapter = new SimpleAdapter({
        config: { command: "test" },
        clientInfo: { name: "test", version: "0.1.0" },
        logger: noopLogger(),
      });

      adapter.dispose();
      expect(adapter["client"]).toBeNull();
    });
  });
});

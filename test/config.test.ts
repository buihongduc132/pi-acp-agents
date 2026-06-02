import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, validateConfig, DEFAULT_CONFIG } from "../src/config/config.js";

describe("config", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-cfg-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("DEFAULT_CONFIG", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_CONFIG.staleTimeoutMs).toBe(3_600_000);
      expect(DEFAULT_CONFIG.healthCheckIntervalMs).toBe(30_000);
      expect(DEFAULT_CONFIG.circuitBreakerMaxFailures).toBe(3);
      expect(DEFAULT_CONFIG.circuitBreakerResetMs).toBe(60_000);
      expect(DEFAULT_CONFIG.modelPolicy).toEqual({
        allowedModels: [],
        blockedModels: [],
        requireProviderPrefix: false,
      });
    });
  });

  describe("validateConfig", () => {
    it("accepts valid config with one agent", () => {
      const config = validateConfig({ agent_servers: { gemini: { command: "gemini", args: ["--acp"] } } });
      expect(config.agent_servers.gemini.command).toBe("gemini");
    });

    it("accepts empty agent_servers", () => {
      const result = validateConfig({ agent_servers: {} });
      expect(result.agent_servers).toEqual({});
    });

    it("throws if agent command is missing", () => {
      expect(() => validateConfig({ agent_servers: { bad: { args: ["--acp"] } } as any })).toThrow(/command/i);
    });

    it("accepts agent without command when mode is 'acpx'", () => {
      const config = validateConfig({
        agent_servers: {
          "gemini-acpx": { mode: "acpx" as const },
        },
      });
      expect(config.agent_servers["gemini-acpx"].mode).toBe("acpx");
    });

    it("accepts agent with both mode 'acpx' and optional command", () => {
      const config = validateConfig({
        agent_servers: {
          "gemini-acpx": { mode: "acpx" as const, default_model: "gemini-2.5-pro" },
        },
      });
      expect(config.agent_servers["gemini-acpx"].default_model).toBe("gemini-2.5-pro");
    });

    it("merges default values", () => {
      const config = validateConfig({ agent_servers: { gemini: { command: "gemini" } } });
      expect(config.staleTimeoutMs).toBe(3_600_000);
      expect(config.healthCheckIntervalMs).toBe(30_000);
      expect(config.modelPolicy?.requireProviderPrefix).toBe(false);
    });

    it("accepts custom overrides", () => {
      const config = validateConfig({
        agent_servers: { gemini: { command: "gemini" } },
        staleTimeoutMs: 30_000,
        circuitBreakerMaxFailures: 5,
        modelPolicy: { requireProviderPrefix: true, blockedModels: ["gemini/bad"] },
      });
      expect(config.staleTimeoutMs).toBe(30_000);
      expect(config.circuitBreakerMaxFailures).toBe(5);
      expect(config.modelPolicy).toEqual({
        allowedModels: [],
        blockedModels: ["gemini/bad"],
        requireProviderPrefix: true,
      });
    });
  });

  describe("loadConfig", () => {
    it("loads config from a JSON file", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({ agent_servers: { gemini: { command: "gemini", args: ["--acp"] } }, defaultAgent: "gemini" }));
      const config = loadConfig(configPath);
      expect(config.defaultAgent).toBe("gemini");
    });

    it("returns default config if file doesn't exist", () => {
      const config = loadConfig(join(tmpDir, "nonexistent.json"));
      expect(config.agent_servers).toEqual({});
    });

    it("returns default config if file is invalid JSON", () => {
      const configPath = join(tmpDir, "bad.json");
      writeFileSync(configPath, "not json {{{");
      const config = loadConfig(configPath);
      expect(config.agent_servers).toEqual({});
    });
  });

  describe("agent_aliases validation", () => {
    it("accepts valid failover alias", () => {
      const config = validateConfig({
        agent_servers: { gemini: { command: "gemini" }, claude: { command: "claude" } },
        agent_aliases: {
          myAssistant: { agents: ["gemini", "claude"], strategy: "failover" },
        },
      });
      expect(config.agent_aliases?.myAssistant.strategy).toBe("failover");
      expect(config.agent_aliases?.myAssistant.agents).toEqual(["gemini", "claude"]);
    });

    it("accepts valid race alias", () => {
      const config = validateConfig({
        agent_servers: { gemini: { command: "gemini" }, claude: { command: "claude" } },
        agent_aliases: {
          fastReply: { agents: ["gemini", "claude"], strategy: "race" },
        },
      });
      expect(config.agent_aliases?.fastReply.strategy).toBe("race");
    });

    it("rejects alias with empty agents array", () => {
      expect(() =>
        validateConfig({
          agent_servers: { gemini: { command: "gemini" } },
          agent_aliases: { bad: { agents: [], strategy: "failover" } },
        }),
      ).toThrow(/non-empty agents/);
    });

    it("rejects alias with invalid strategy", () => {
      expect(() =>
        validateConfig({
          agent_servers: { gemini: { command: "gemini" } },
          agent_aliases: { bad: { agents: ["gemini"], strategy: "random" as any } },
        }),
      ).toThrow(/strategy must be/);
    });

    it("rejects alias referencing unknown agent", () => {
      expect(() =>
        validateConfig({
          agent_servers: { gemini: { command: "gemini" } },
          agent_aliases: { bad: { agents: ["gemini", "unknown"], strategy: "failover" } },
        }),
      ).toThrow(/unknown agent/);
    });

    it("accepts config without agent_aliases", () => {
      const config = validateConfig({
        agent_servers: { gemini: { command: "gemini" } },
      });
      expect(config.agent_aliases).toBeUndefined();
    });

    it("loads agent_aliases from file", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        agent_servers: { gemini: { command: "gemini" }, claude: { command: "claude" } },
        agent_aliases: {
          fallback: { agents: ["gemini", "claude"], strategy: "failover" },
        },
      }));
      const config = loadConfig(configPath);
      expect(config.agent_aliases?.fallback).toBeDefined();
      expect(config.agent_aliases?.fallback.strategy).toBe("failover");
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, validateConfig, DEFAULT_CONFIG } from "../src/config/config.js";

describe("config", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "acp-cfg-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  describe("DEFAULT_CONFIG", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_CONFIG.staleTimeoutMs).toBe(900_000);
      expect(DEFAULT_CONFIG.healthCheckIntervalMs).toBe(30_000);
      expect(DEFAULT_CONFIG.circuitBreakerMaxFailures).toBe(3);
      expect(DEFAULT_CONFIG.circuitBreakerResetMs).toBe(60_000);
    });
  });

  describe("validateConfig", () => {
    it("accepts valid config with one agent", () => {
      const config = validateConfig({ agents: { gemini: { command: "gemini", args: ["--acp"] } } });
      expect(config.agents.gemini.command).toBe("gemini");
    });

    it("throws if agents is empty", () => {
      expect(() => validateConfig({ agents: {} })).toThrow(/at least one agent/i);
    });

    it("throws if agent command is missing", () => {
      expect(() => validateConfig({ agents: { bad: { args: ["--acp"] } } as any })).toThrow(/command/i);
    });

    it("merges default values", () => {
      const config = validateConfig({ agents: { gemini: { command: "gemini" } } });
      expect(config.staleTimeoutMs).toBe(900_000);
      expect(config.healthCheckIntervalMs).toBe(30_000);
    });

    it("accepts custom overrides", () => {
      const config = validateConfig({ agents: { gemini: { command: "gemini" } }, staleTimeoutMs: 30_000, circuitBreakerMaxFailures: 5 });
      expect(config.staleTimeoutMs).toBe(30_000);
      expect(config.circuitBreakerMaxFailures).toBe(5);
    });
  });

  describe("loadConfig", () => {
    it("loads config from a JSON file", () => {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({ agents: { gemini: { command: "gemini", args: ["--acp"] } }, defaultAgent: "gemini" }));
      const config = loadConfig(configPath);
      expect(config.defaultAgent).toBe("gemini");
    });

    it("returns default config if file doesn't exist", () => {
      const config = loadConfig(join(tmpDir, "nonexistent.json"));
      expect(config.agents).toEqual({});
    });

    it("returns default config if file is invalid JSON", () => {
      const configPath = join(tmpDir, "bad.json");
      writeFileSync(configPath, "not json {{{");
      const config = loadConfig(configPath);
      expect(config.agents).toEqual({});
    });
  });
});

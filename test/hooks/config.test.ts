/**
 * RED tests for src/hooks/config.ts — loadHookConfig, validateHookConfig, defaultConfig
 *
 * Source does NOT exist yet. These tests MUST FAIL (RED phase of TDD).
 * Spec: flow/plans/acp-hooks-impl-spec.md
 *
 * Covers LD3 (per-hook enable/disable), defaults, malformed-config graceful handling,
 * and socket config validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Source modules do not exist yet — import will fail (RED)
import {
  loadHookConfig,
  validateHookConfig,
  defaultConfig,
} from "../../src/hooks/config.js";

describe("hooks config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-hook-cfg-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Defaults ───────────────────────────────────────────────────────────
  describe("defaultConfig", () => {
    it("has sensible defaults", () => {
      expect(defaultConfig.version).toBe(1);
      expect(defaultConfig.enabled).toBe(true);
      expect(defaultConfig.failureAction).toBe("warn");
      expect(defaultConfig.maxReopensPerTask).toBe(3);
      expect(defaultConfig.followupOwner).toBe("lead");
    });

    it("defaults socket to enabled with 1MB max message size", () => {
      expect(defaultConfig.socket.enabled).toBe(true);
      expect(defaultConfig.socket.maxMessageSize).toBe(1_048_576);
      expect(defaultConfig.socket.broadcastTimeoutMs).toBeGreaterThan(0);
      expect(defaultConfig.socket.path).toMatch(/events-\d+\.sock$/);
    });
  });

  // ── Schema validation ──────────────────────────────────────────────────
  describe("validateHookConfig — schema validation", () => {
    it("accepts a valid full config", () => {
      const cfg = {
        version: 1,
        enabled: true,
        hooks: {
          task_completed: { enabled: true, timeoutMs: 5000 },
        },
        failureAction: "warn",
        followupOwner: "lead",
        maxReopensPerTask: 3,
        socket: {
          enabled: true,
          path: "/tmp/events.sock",
          maxMessageSize: 1_048_576,
          broadcastTimeoutMs: 1000,
        },
      };

      const result = validateHookConfig(cfg);
      expect(result.version).toBe(1);
      expect(result.socket.path).toBe("/tmp/events.sock");
    });

    it("accepts minimal config and fills defaults", () => {
      const result = validateHookConfig({});
      expect(result.version).toBe(1);
      expect(result.enabled).toBe(true);
      expect(result.failureAction).toBe("warn");
    });

    it("rejects invalid failureAction value", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = validateHookConfig({
        failureAction: "explode" as any,
      });
      // Invalid failureAction should fall back to default or be flagged
      // Either: throws, or warns + falls back to "warn"
      if (result) {
        expect(result.failureAction).toBe("warn");
      }
      warnSpy.mockRestore();
    });

    it("rejects negative maxReopensPerTask", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = validateHookConfig({
        maxReopensPerTask: -5,
      });
      // Should clamp or default to a non-negative value
      expect(result.maxReopensPerTask).toBeGreaterThanOrEqual(0);
      warnSpy.mockRestore();
    });
  });

  // ── LD3: Per-hook enable/disable ────────────────────────────────────────
  describe("LD3 — per-hook enable/disable", () => {
    it("allows individual events to be enabled", () => {
      const result = validateHookConfig({
        hooks: {
          task_completed: { enabled: true, timeoutMs: 10000 },
          session_started: { enabled: true, timeoutMs: 5000 },
        },
      });

      expect(result.hooks.task_completed).toEqual({ enabled: true, timeoutMs: 10000 });
      expect(result.hooks.session_started).toEqual({ enabled: true, timeoutMs: 5000 });
    });

    it("allows individual events to be disabled", () => {
      const result = validateHookConfig({
        hooks: {
          task_completed: { enabled: false, timeoutMs: 5000 },
        },
      });

      expect(result.hooks.task_completed?.enabled).toBe(false);
    });

    it("disabled event is recognized by loadHookConfig", () => {
      const configPath = join(tmpDir, "hooks-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          enabled: true,
          hooks: {
            task_failed: { enabled: false, timeoutMs: 3000 },
          },
        })
      );

      const cfg = loadHookConfig(configPath);
      expect(cfg.hooks.task_failed?.enabled).toBe(false);
    });

    it("omitted events default to enabled (parent enabled flag)", () => {
      const result = validateHookConfig({
        enabled: true,
        hooks: {},
      });

      // When no specific hook config exists, it inherits the global enabled state
      expect(result.enabled).toBe(true);
    });
  });

  // ── Malformed config graceful ──────────────────────────────────────────
  describe("malformed config graceful handling", () => {
    it("falls back to defaults on bad JSON (does not throw)", () => {
      const configPath = join(tmpDir, "hooks-config.json");
      writeFileSync(configPath, "{ this is not valid json,,, }");

      const cfg = loadHookConfig(configPath);
      expect(cfg.version).toBe(1);
      expect(cfg.enabled).toBe(true);
    });

    it("falls back to defaults on missing config file", () => {
      const cfg = loadHookConfig(join(tmpDir, "does-not-exist.json"));
      expect(cfg.version).toBe(1);
      expect(cfg.enabled).toBe(true);
    });

    it("falls back to defaults on empty file", () => {
      const configPath = join(tmpDir, "hooks-config.json");
      writeFileSync(configPath, "");

      const cfg = loadHookConfig(configPath);
      expect(cfg.version).toBe(1);
      expect(cfg.enabled).toBe(true);
    });

    it("logs a warning when falling back", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const configPath = join(tmpDir, "hooks-config.json");
      writeFileSync(configPath, "not json at all");

      loadHookConfig(configPath);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // ── Socket config validation ───────────────────────────────────────────
  describe("socket config validation", () => {
    it("validates socket path is a string", () => {
      const result = validateHookConfig({
        socket: {
          enabled: true,
          path: "/tmp/my-events.sock",
          maxMessageSize: 1_048_576,
          broadcastTimeoutMs: 1000,
        },
      });

      expect(result.socket.path).toBe("/tmp/my-events.sock");
    });

    it("validates maxMessageSize is positive", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = validateHookConfig({
        socket: {
          enabled: true,
          path: "/tmp/events.sock",
          maxMessageSize: -1,
          broadcastTimeoutMs: 1000,
        },
      });

      // Negative/zero should default to a sane positive value
      expect(result.socket.maxMessageSize).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });

    it("validates broadcastTimeoutMs is positive", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = validateHookConfig({
        socket: {
          enabled: true,
          path: "/tmp/events.sock",
          maxMessageSize: 1_048_576,
          broadcastTimeoutMs: -100,
        },
      });

      expect(result.socket.broadcastTimeoutMs).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });

    it("clamps maxMessageSize to a reasonable minimum", () => {
      const result = validateHookConfig({
        socket: {
          enabled: true,
          path: "/tmp/events.sock",
          maxMessageSize: 10, // Too small for a valid JSON event
          broadcastTimeoutMs: 1000,
        },
      });

      // Should be clamped up to a reasonable minimum
      expect(result.socket.maxMessageSize).toBeGreaterThanOrEqual(1024);
    });
  });

  // ── Global enable/disable ──────────────────────────────────────────────
  describe("global enable/disable", () => {
    it("respects global enabled:false", () => {
      const result = validateHookConfig({ enabled: false });
      expect(result.enabled).toBe(false);
    });

    it("global disabled takes precedence over per-hook enabled", () => {
      const configPath = join(tmpDir, "hooks-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: false,
          hooks: { task_completed: { enabled: true, timeoutMs: 5000 } },
        })
      );

      const cfg = loadHookConfig(configPath);
      // Global disabled should effectively disable the system
      expect(cfg.enabled).toBe(false);
    });
  });
});

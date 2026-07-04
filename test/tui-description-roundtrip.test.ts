/**
 * RED phase tests — OpenSpec change `agent-profile-description` section 4
 * (agent-config TUI editor: description field).
 *
 * These tests describe the CONTRACT that production code does NOT yet satisfy.
 * They are EXPECTED TO FAIL until the GREEN phase implements:
 *   - `upsertAgentServer` preserving `description` (string) when provided,
 *     and omitting the key entirely when description is empty/undefined/null.
 *   - `formatAgentDescription` surfacing the description.
 *   - The TUI edit submenu exposing a description input, including `description`
 *     in the JSON payload built on Enter, and `handleSubmenuResult` passing it
 *     through to `upsertAgentServer`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { upsertAgentServer, validateConfig } from "../src/config/config.js";
import type { AcpConfig } from "../src/config/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TUI_SRC_PATH = join(__dirname, "..", "src", "settings", "agent-config-tui.ts");

function baseConfig(): AcpConfig {
	return validateConfig({ agent_servers: {} });
}

describe("RED: agent-profile-description — TUI description round-trip", () => {
	// ── A. upsertAgentServer round-trip WITH description ────────────────
	describe("upsertAgentServer persists description when provided", () => {
		it("stores a non-empty description string on the entry", () => {
			const cfg = baseConfig();
			const result = upsertAgentServer(cfg, "bot", {
				command: "echo",
				description: "does X",
			} as any);
			expect(result.agent_servers.bot.description).toBe("does X");
		});

		it("stores a multi-word description verbatim", () => {
			const cfg = baseConfig();
			const result = upsertAgentServer(cfg, "bot", {
				command: "echo",
				description: "A longer description with spaces.",
			} as any);
			expect(result.agent_servers.bot.description).toBe(
				"A longer description with spaces.",
			);
		});
	});

	// ── B. EMPTY / undefined description → no description key ───────────
	describe("upsertAgentServer omits description key when not provided", () => {
		it("has NO description key when description omitted", () => {
			const cfg = baseConfig();
			const result = upsertAgentServer(cfg, "bot", { command: "echo" });
			expect(result.agent_servers.bot).not.toHaveProperty("description");
		});

		it("has NO description key when description is undefined", () => {
			const cfg = baseConfig();
			const result = upsertAgentServer(cfg, "bot", {
				command: "echo",
				description: undefined,
			} as any);
			expect(result.agent_servers.bot).not.toHaveProperty("description");
		});

		it("has NO description key when description is empty string", () => {
			const cfg = baseConfig();
			const result = upsertAgentServer(cfg, "bot", {
				command: "echo",
				description: "",
			} as any);
			expect(result.agent_servers.bot).not.toHaveProperty("description");
		});
	});

	// ── C. null description → treated as absent (NOT persisted as null) ─
	describe("upsertAgentServer treats null description as absent", () => {
		it("has NO description key when description is null", () => {
			const cfg = baseConfig();
			const result = upsertAgentServer(cfg, "bot", {
				command: "echo",
				description: null,
			} as any);
			expect(result.agent_servers.bot).not.toHaveProperty("description");
			// Explicitly: must NOT be persisted as null.
			expect(result.agent_servers.bot.description).not.toBeNull();
		});
	});

	// ── D. Source-text contract on agent-config-tui.ts ─────────────────
	describe("agent-config-tui.ts source exposes description in edit flow", () => {
		const src = readFileSync(TUI_SRC_PATH, "utf-8");

		it("declares a description input field (descriptionInput or similar)", () => {
			// Accept any clearly-named description input variable.
			expect(/descriptionInput\b|description[A-Za-z]*\s*=\s*new\s+Input/.test(src)).toBe(true);
		});

		it("includes `description:` in the JSON payload built on Enter (edit action)", () => {
			// Find the JSON.stringify({ ... action: "edit" ... }) block and
			// assert it carries a description field.
			const editPayloadMatch = src.match(/JSON\.stringify\(\{[^}]*action:\s*"edit"[^}]*\}\)/s);
			expect(editPayloadMatch, "edit-action JSON.stringify payload not found").not.toBeNull();
			expect(editPayloadMatch![0]).toContain("description:");
		});

		it("Tab cycle includes a description field", () => {
			// The edit-mode Tab cycle should mention a description field among
			// its activeField union or Tab-rotation sequence.
			expect(src).toMatch(/description/);
		});

		it("handleSubmenuResult passes description to upsertAgentServer", () => {
			// handleSubmenuResult must reference parsed.description OR pass a
			// description field into the upsertAgentServer agent arg.
			expect(src).toMatch(/parsed\.description|description:\s*parsed\.description/);
		});
	});

	// ── E. formatAgentDescription surfaces description ──────────────────
	describe("formatAgentDescription surfaces description", () => {
		it("function body references `description`", () => {
			const src = readFileSync(TUI_SRC_PATH, "utf-8");
			// Extract the formatAgentDescription function body.
			const fnMatch = src.match(
				/function\s+formatAgentDescription\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/,
			);
			expect(fnMatch, "formatAgentDescription function not found").not.toBeNull();
			expect(fnMatch![1]).toContain("description");
		});
	});
});

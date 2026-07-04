import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

/**
 * RED-phase parity tests for the OpenSpec change `agent-profile-description`.
 *
 * This change adds an optional `description?: string` field to `AcpAgentConfig`.
 * The type is defined in TWO places that MUST stay in parity:
 *
 *   1. src/config/types.ts            (base package)
 *   2. packages/pi-acp-types/src/index.ts (shared types package)
 *
 * These tests mirror the text-scanning approach used by test/split.test.ts
 * (readFileSync + toContain) — they do NOT import the types at runtime.
 *
 * Until the GREEN phase adds the field + docblock to both files, every
 * assertion below MUST fail.
 */

const SRC_TYPES = join(ROOT, "src", "config", "types.ts");
const PKG_TYPES = join(ROOT, "packages", "pi-acp-types", "src", "index.ts");

/**
 * The docblock that should accompany the new field. It must mention BOTH
 * "profile" (this describes the agent profile) and "server" (the entry is an
 * agent server definition). We assert each keyword independently so the
 * contract is explicit.
 */
const PROFILE_DOC_KEYWORDS = ["profile", "server"] as const;

describe("agent-profile-description — src/config/types.ts", () => {
	const content = readFileSync(SRC_TYPES, "utf-8");

	it("declares `description?: string;` on AcpAgentConfig", () => {
		expect(content).toContain("description?: string;");
	});

	it("ships a docblock on the field mentioning 'profile' (within 200 chars of the field)", () => {
		const fieldIdx = content.indexOf("description?: string;");
		expect(fieldIdx).toBeGreaterThanOrEqual(0);
		expect(content.slice(fieldIdx, fieldIdx + 200)).toContain("profile");
	});

	it("ships a docblock on the field mentioning 'server' (within 200 chars of the field)", () => {
		const fieldIdx = content.indexOf("description?: string;");
		expect(fieldIdx).toBeGreaterThanOrEqual(0);
		expect(content.slice(fieldIdx, fieldIdx + 200)).toContain("server");
	});

	it("docblock sits next to the description field (profile + server within 200 chars of the field)", () => {
		const fieldIdx = content.indexOf("description?: string;");
		expect(fieldIdx).toBeGreaterThanOrEqual(0);
		const window = content.slice(fieldIdx, fieldIdx + 200);
		for (const kw of PROFILE_DOC_KEYWORDS) {
			expect(window).toContain(kw);
		}
	});
});

describe("agent-profile-description — packages/pi-acp-types/src/index.ts", () => {
	const content = readFileSync(PKG_TYPES, "utf-8");

	it("declares `description?: string;` on AcpAgentConfig", () => {
		expect(content).toContain("description?: string;");
	});

	it("ships a docblock on the field mentioning 'profile' (within 200 chars of the field)", () => {
		const fieldIdx = content.indexOf("description?: string;");
		expect(fieldIdx).toBeGreaterThanOrEqual(0);
		expect(content.slice(fieldIdx, fieldIdx + 200)).toContain("profile");
	});

	it("ships a docblock on the field mentioning 'server' (within 200 chars of the field)", () => {
		const fieldIdx = content.indexOf("description?: string;");
		expect(fieldIdx).toBeGreaterThanOrEqual(0);
		expect(content.slice(fieldIdx, fieldIdx + 200)).toContain("server");
	});

	it("docblock sits next to the description field (profile + server within 200 chars of the field)", () => {
		const fieldIdx = content.indexOf("description?: string;");
		expect(fieldIdx).toBeGreaterThanOrEqual(0);
		const window = content.slice(fieldIdx, fieldIdx + 200);
		for (const kw of PROFILE_DOC_KEYWORDS) {
			expect(window).toContain(kw);
		}
	});
});

describe("agent-profile-description — parity between both copies", () => {
	it("BOTH files contain `description?: string;`", () => {
		const src = readFileSync(SRC_TYPES, "utf-8");
		const pkg = readFileSync(PKG_TYPES, "utf-8");
		expect(src).toContain("description?: string;");
		expect(pkg).toContain("description?: string;");
	});

	it("BOTH files mention 'profile' in a docblock near the field", () => {
		const src = readFileSync(SRC_TYPES, "utf-8");
		const pkg = readFileSync(PKG_TYPES, "utf-8");
		for (const content of [src, pkg]) {
			const fieldIdx = content.indexOf("description?: string;");
			expect(fieldIdx).toBeGreaterThanOrEqual(0);
			expect(content.slice(fieldIdx, fieldIdx + 200)).toContain("profile");
		}
	});

	it("BOTH files mention 'server' in a docblock near the field", () => {
		const src = readFileSync(SRC_TYPES, "utf-8");
		const pkg = readFileSync(PKG_TYPES, "utf-8");
		for (const content of [src, pkg]) {
			const fieldIdx = content.indexOf("description?: string;");
			expect(fieldIdx).toBeGreaterThanOrEqual(0);
			expect(content.slice(fieldIdx, fieldIdx + 200)).toContain("server");
		}
	});
});

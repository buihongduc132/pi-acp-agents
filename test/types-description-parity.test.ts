import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

/**
 * Parity tests for the OpenSpec change `agent-profile-description`.
 *
 * The change adds an optional `description?: string` field to `AcpAgentConfig`.
 * The type is defined in TWO places that MUST stay in parity:
 *
 *   1. src/config/types.ts            (base package)
 *   2. packages/pi-acp-types/src/index.ts (shared types package)
 *
 * These tests mirror the text-scanning approach used by test/split.test.ts
 * (readFileSync + toContain) — they do NOT import the types at runtime.
 *
 * The docblock for the field sits ABOVE the declaration (idiomatic JSDoc), so
 * we scan a window around the field (200 chars before, 50 after) rather than
 * only forward from it.
 */

const SRC_TYPES = join(ROOT, "src", "config", "types.ts");
const PKG_TYPES = join(ROOT, "packages", "pi-acp-types", "src", "index.ts");

/** The docblock must mention BOTH keywords to express the profile-vs-server model. */
const PROFILE_DOC_KEYWORDS = ["profile", "server"] as const;

/** Window around the field declaration that should contain the docblock. */
function docWindow(content: string, fieldIdx: number, before = 200, after = 50): string {
	return content.slice(Math.max(0, fieldIdx - before), fieldIdx + after);
}

function fieldIndex(content: string): number {
	return content.indexOf("description?: string;");
}

describe("agent-profile-description — src/config/types.ts", () => {
	const content = readFileSync(SRC_TYPES, "utf-8");

	it("declares `description?: string;` on AcpAgentConfig", () => {
		expect(content).toContain("description?: string;");
	});

	it("ships a docblock near the field mentioning 'profile'", () => {
		expect(docWindow(content, fieldIndex(content))).toContain("profile");
	});

	it("ships a docblock near the field mentioning 'server'", () => {
		expect(docWindow(content, fieldIndex(content))).toContain("server");
	});

	it("docblock near the field mentions both profile + server", () => {
		const window = docWindow(content, fieldIndex(content));
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

	it("ships a docblock near the field mentioning 'profile'", () => {
		expect(docWindow(content, fieldIndex(content))).toContain("profile");
	});

	it("ships a docblock near the field mentioning 'server'", () => {
		expect(docWindow(content, fieldIndex(content))).toContain("server");
	});

	it("docblock near the field mentions both profile + server", () => {
		const window = docWindow(content, fieldIndex(content));
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
		for (const content of [readFileSync(SRC_TYPES, "utf-8"), readFileSync(PKG_TYPES, "utf-8")]) {
			expect(docWindow(content, fieldIndex(content))).toContain("profile");
		}
	});

	it("BOTH files mention 'server' in a docblock near the field", () => {
		for (const content of [readFileSync(SRC_TYPES, "utf-8"), readFileSync(PKG_TYPES, "utf-8")]) {
			expect(docWindow(content, fieldIndex(content))).toContain("server");
		}
	});
});

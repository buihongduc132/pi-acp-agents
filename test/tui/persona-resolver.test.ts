/**
 * Tests for src/tui/persona-resolver.ts — resolves a per-alias systemPrompt
 * string by content shape: inline (has whitespace) | file (bare path) | gist
 * (http-prefix, DEFERRED). Soft-fail: never throws; returns a warning on
 * unresolvable sources.
 *
 * RED phase: tests written before implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePersona } from "../../src/tui/persona-resolver.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "persona-resolver-test-" + process.pid);

beforeEach(() => {
	try { mkdirSync(TMP, { recursive: true }); } catch { /* exists */ }
});
afterEach(() => {
		vi.restoreAllMocks();
		try { rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ }
});

describe("resolvePersona", () => {
	it("resolves inline persona when value contains whitespace", () => {
		const r = resolvePersona("You are a senior reviewer. Reject vague claims.");
		expect(r.kind).toBe("inline");
		expect(r.text).toBe("You are a senior reviewer. Reject vague claims.");
		expect(r.warning).toBeUndefined();
	});

	it("resolves file persona when value is a bare path (no whitespace)", () => {
		const f = join(TMP, "reviewer.md");
		writeFileSync(f, "# Reviewer persona\nBe strict.");
		const r = resolvePersona(f);
		expect(r.kind).toBe("file");
		expect(r.text).toContain("Be strict.");
		expect(r.warning).toBeUndefined();
	});

	it("soft-fails with warning when file does not exist", () => {
		const r = resolvePersona(join(TMP, "nonexistent.md"));
		expect(r.text).toBeUndefined();
		expect(r.warning).toMatch(/not found|missing|file/i);
		// Critical: does NOT throw.
	});

	it("resolves http(s) gist URL as DEFERRED (no network call)", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const r = resolvePersona("https://gist.github.com/user/abc123");
			expect(r.kind).toBe("gist");
			expect(r.text).toBeUndefined();
			expect(r.warning).toMatch(/deferred|not yet supported/i);
			// CRITICAL: no network call attempted.
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("resolves http:// (non-https) gist as deferred too", () => {
		const r = resolvePersona("http://gist.github.com/user/xyz");
		expect(r.kind).toBe("gist");
		expect(r.warning).toMatch(/deferred/i);
	});

	it("returns empty/inline for empty string (no persona)", () => {
		const r = resolvePersona("");
		expect(r.kind).toBe("none");
		expect(r.text ?? "").toBe("");
		expect(r.warning).toBeUndefined();
	});

	it("resolves undefined as no-op (no persona)", () => {
		const r = resolvePersona(undefined);
		expect(r.kind).toBe("none");
		expect(r.text).toBeUndefined();
		expect(r.warning).toBeUndefined();
	});

	it("inline wins for multi-word values that look path-like", () => {
		// Contains space → inline, even if it has slashes.
		const r = resolvePersona("/some/path with space");
		expect(r.kind).toBe("inline");
	});

	it("single bare word with no whitespace is treated as file path", () => {
		// Deterministic: use a known-nonexistent temp path (cubic 3521686099).
		const r = resolvePersona(join(TMP, "definitely-nonexistent-for-test.md"));
		expect(r.warning).toBeDefined();
	});
});

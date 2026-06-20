import { describe, it, expect } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.6: Implement output truncation — if output exceeds a configurable
 * limit (default 8000 chars), truncate with
 * `\n\n[... output truncated, N chars omitted ...]`.
 *
 * These tests assert the truncation behaviour required by the
 * `dag-execution` spec ("Template variable resolution" →
 * "Truncate large outputs"):
 *   - WHEN step "a" output is 15000 characters and the limit is 8000
 *   - THEN the resolved `{a.output}` SHALL be the first 8000 characters
 *     followed by `\n\n[... output truncated, 7000 chars omitted ...]`.
 *
 * Truncation applies to every injected `{<step-id>.output}` reference,
 * uses the configured `truncateChars` limit, and is skipped when the
 * output is at or below the limit (design.md D3 / risk R1).
 */
describe("TemplateResolver — output truncation (task 4.6)", () => {
	it("truncates a 15000-char output to 8000 + omission marker (spec scenario)", () => {
		const resolver = new TemplateResolver({ truncateChars: 8_000 });
		const longOutput = "x".repeat(15_000);
		const out = resolver.resolve(
			"Based on {a.output}",
			{ a: longOutput },
			{},
			{},
		);
		expect(out).toBe(
			"Based on " +
				"x".repeat(8_000) +
				"\n\n[... output truncated, 7000 chars omitted ...]",
		);
	});

	it("does not truncate when output length equals the limit exactly", () => {
		const resolver = new TemplateResolver({ truncateChars: 8_000 });
		const exactlyLimit = "y".repeat(8_000);
		const out = resolver.resolve("{a.output}", { a: exactlyLimit }, {}, {});
		expect(out).toBe(exactlyLimit);
	});

	it("does not truncate when output is shorter than the limit", () => {
		const resolver = new TemplateResolver({ truncateChars: 8_000 });
		const out = resolver.resolve(
			"{a.output}",
			{ a: "short" },
			{},
			{},
		);
		expect(out).toBe("short");
	});

	it("uses the default 8000-char limit when none is configured", () => {
		const resolver = new TemplateResolver();
		const longOutput = "z".repeat(8_001);
		const out = resolver.resolve("{a.output}", { a: longOutput }, {}, {});
		expect(out).toBe(
			"z".repeat(8_000) +
				"\n\n[... output truncated, 1 chars omitted ...]",
		);
	});

	it("respects a custom non-default truncation limit", () => {
		const resolver = new TemplateResolver({ truncateChars: 10 });
		const out = resolver.resolve(
			"{a.output}",
			{ a: "0123456789ABCDEF" }, // 16 chars
			{},
			{},
		);
		expect(out).toBe(
			"0123456789" + "\n\n[... output truncated, 6 chars omitted ...]",
		);
	});

	it("counts the omission in chars correctly for very large outputs", () => {
		const resolver = new TemplateResolver({ truncateChars: 1_000 });
		const longOutput = "q".repeat(10_000);
		const out = resolver.resolve("{a.output}", { a: longOutput }, {}, {});
		expect(out).toBe(
			"q".repeat(1_000) +
				"\n\n[... output truncated, 9000 chars omitted ...]",
		);
	});

	it("truncates each independently when two references exceed the limit", () => {
		const resolver = new TemplateResolver({ truncateChars: 5 });
		const out = resolver.resolve(
			"{a.output}|{b.output}",
			{ a: "AAAAAA", b: "BBBBBBBB" }, // 6 and 8 chars
			{},
			{},
		);
		expect(out).toBe(
			"AAAAA\n\n[... output truncated, 1 chars omitted ...]" +
				"|" +
				"BBBBB\n\n[... output truncated, 3 chars omitted ...]",
		);
	});

	it("leaves unresolved references untouched (no truncation path)", () => {
		const resolver = new TemplateResolver({ truncateChars: 8_000 });
		const out = resolver.resolve("{missing.output}", {}, {}, {});
		expect(out).toBe("{missing.output}");
	});
});

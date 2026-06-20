import { describe, it, expect, vi } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.8: Unit tests for TemplateResolver.
 *
 * This is the canonical consolidated test file for the TemplateResolver
 * (src/dag/template-resolver.ts). It exercises the full public contract
 * defined by tasks 4.1–4.7 and the `dag-execution` spec
 * ("Template variable resolution"):
 *
 *   - 4.1 constructor / options (`truncateChars`, `logger`)
 *   - 4.2 `resolve(prompt, stepOutputs, stepStatuses, dagArgs)` regex
 *        string interpolation
 *   - 4.3 `{<step-id>.output}` resolution
 *   - 4.4 `{<step-id>.status}` resolution
 *   - 4.5 `{dag.args.<key>}` resolution
 *   - 4.6 output truncation (default 8000, configurable)
 *   - 4.7 missing-reference detection (warning logging)
 *
 * Granular per-task files exist alongside this one; this file focuses on
 * end-to-end scenarios that span multiple variable types at once, the
 * exact spec scenarios, option wiring, and the missing-reference warning
 * contract — i.e. the behaviour a caller relies on when composing a real
 * downstream step prompt.
 */

describe("TemplateResolver (task 4.8 — consolidated unit tests)", () => {
	describe("constructor / options (task 4.1)", () => {
		it("constructs with no options and uses the default 8000-char truncation limit", () => {
			const resolver = new TemplateResolver();
			expect(resolver).toBeInstanceOf(TemplateResolver);
			expect(resolver.truncateChars).toBe(8_000);
		});

		it("honours a custom truncateChars option", () => {
			const resolver = new TemplateResolver({ truncateChars: 42 });
			expect(resolver.truncateChars).toBe(42);
		});

		it("is safe to construct without a logger (no-op default)", () => {
			const resolver = new TemplateResolver();
			// Resolving an unresolved reference must not throw even with no
			// logger injected — the default logger is a no-op.
			expect(() => resolver.resolve("{x.output}", {}, {}, {})).not.toThrow();
		});
	});

	describe("resolve() — basic interpolation (task 4.2)", () => {
		it("returns a plain prompt with no template variables unchanged", () => {
			const resolver = new TemplateResolver();
			expect(resolver.resolve("just text", {}, {}, {})).toBe("just text");
		});

		it("returns an empty string prompt unchanged", () => {
			const resolver = new TemplateResolver();
			expect(resolver.resolve("", {}, {}, {})).toBe("");
		});

		it("exposes resolve as a function with the documented arity", () => {
			const resolver = new TemplateResolver();
			expect(typeof resolver.resolve).toBe("function");
			expect(resolver.resolve.length).toBe(4);
		});
	});

	describe("{<step-id>.output} resolution (task 4.3)", () => {
		it("expands an upstream step output (spec scenario: {a.output})", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"Implement based on {a.output}",
				{ a: "Use JWT tokens" },
				{},
				{},
			);
			expect(out).toBe("Implement based on Use JWT tokens");
		});

		it("expands the same reference repeatedly", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"{a.output} :: {a.output}",
				{ a: "X" },
				{},
				{},
			);
			expect(out).toBe("X :: X");
		});

		it("expands references with hyphenated / underscored / numeric ids", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"{data-fetch.output} {data_fetch.output} {step1.output}",
				{ "data-fetch": "a", data_fetch: "b", step1: "c" },
				{},
				{},
			);
			expect(out).toBe("a b c");
		});

		it("leaves an unresolved output reference untouched", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve("Use {ghost.output}", {}, {}, {});
			expect(out).toBe("Use {ghost.output}");
		});

		it("does not recursively expand template-like content inside a value", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"{a.output}",
				{ a: "literal {b.output} text" },
				{ b: "LEAK" },
				{},
			);
			expect(out).toBe("literal {b.output} text");
		});
	});

	describe("{<step-id>.status} resolution (task 4.4)", () => {
		it("expands a completed step status (spec scenario)", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"Previous step status: {a.status}",
				{},
				{ a: "completed" },
				{},
			);
			expect(out).toBe("Previous step status: completed");
		});

		it("expands other lifecycle statuses (running / failed / skipped)", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"{a.status}/{b.status}/{c.status}",
				{},
				{ a: "running", b: "failed", c: "skipped" },
				{},
			);
			expect(out).toBe("running/failed/skipped");
		});

		it("leaves an unresolved status reference untouched", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve("{ghost.status}", {}, {}, {});
			expect(out).toBe("{ghost.status}");
		});
	});

	describe("{dag.args.<key>} resolution (task 4.5)", () => {
		it("expands a workflow-level argument (spec scenario)", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"Write in {dag.args.lang}",
				{},
				{},
				{ lang: "TypeScript" },
			);
			expect(out).toBe("Write in TypeScript");
		});

		it("expands multiple distinct dag args in one prompt", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"{dag.args.topic} / {dag.args.lang}",
				{},
				{},
				{ topic: "auth", lang: "TS" },
			);
			expect(out).toBe("auth / TS");
		});

		it("expands dag args with hyphenated / underscored keys", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"{dag.args.my-key} {dag.args.my_key}",
				{},
				{},
				{ "my-key": "A", my_key: "B" },
			);
			expect(out).toBe("A B");
		});

		it("leaves an unresolved dag arg reference untouched", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve("Use {dag.args.missing}", {}, {}, {});
			expect(out).toBe("Use {dag.args.missing}");
		});
	});

	describe("output truncation (task 4.6)", () => {
		it("truncates a 15000-char output to 8000 + omission marker (spec scenario)", () => {
			const resolver = new TemplateResolver({ truncateChars: 8_000 });
			const out = resolver.resolve(
				"Based on {a.output}",
				{ a: "x".repeat(15_000) },
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
			const out = resolver.resolve(
				"{a.output}",
				{ a: "y".repeat(8_000) },
				{},
				{},
			);
			expect(out).toBe("y".repeat(8_000));
		});

		it("uses the default 8000-char limit when none is configured", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve("{a.output}", { a: "z".repeat(8_001) }, {}, {});
			expect(out).toBe(
				"z".repeat(8_000) +
					"\n\n[... output truncated, 1 chars omitted ...]",
			);
		});

		it("respects a custom non-default truncation limit", () => {
			const resolver = new TemplateResolver({ truncateChars: 10 });
			const out = resolver.resolve(
				"{a.output}",
				{ a: "0123456789ABCDEF" },
				{},
				{},
			);
			expect(out).toBe(
				"0123456789" + "\n\n[... output truncated, 6 chars omitted ...]",
			);
		});

		it("truncates each independently when two references exceed the limit", () => {
			const resolver = new TemplateResolver({ truncateChars: 5 });
			const out = resolver.resolve(
				"{a.output}|{b.output}",
				{ a: "AAAAAA", b: "BBBBBBBB" },
				{},
				{},
			);
			expect(out).toBe(
				"AAAAA\n\n[... output truncated, 1 chars omitted ...]" +
					"|" +
					"BBBBB\n\n[... output truncated, 3 chars omitted ...]",
			);
		});
	});

	describe("missing-reference detection (task 4.7)", () => {
		it("does not warn when there are no template variables", () => {
			const logger = { warn: vi.fn() };
			const resolver = new TemplateResolver({ logger });
			resolver.resolve("plain prompt with no vars", {}, {}, {});
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it("does not warn when every variable resolves successfully", () => {
			const logger = { warn: vi.fn() };
			const resolver = new TemplateResolver({ logger });
			resolver.resolve(
				"{a.output} {a.status} {dag.args.k}",
				{ a: "out" },
				{ a: "completed" },
				{ k: "v" },
			);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it("warns once per unresolved template variable", () => {
			const logger = { warn: vi.fn() };
			const resolver = new TemplateResolver({ logger });
			resolver.resolve("{x.output} {y.status} {dag.args.z}", {}, {}, {});
			expect(logger.warn).toHaveBeenCalledTimes(3);
		});

		it("includes the unresolved reference text in the warning message", () => {
			const logger = { warn: vi.fn() };
			const resolver = new TemplateResolver({ logger });
			resolver.resolve("{ghost.output}", {}, {}, {});
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("{ghost.output}"),
			);
		});

		it("only warns about references that remain unresolved after interpolation", () => {
			const logger = { warn: vi.fn() };
			const resolver = new TemplateResolver({ logger });
			// {a.output} resolves; {b.output} does not → exactly one warning.
			resolver.resolve("{a.output} {b.output}", { a: "ok" }, {}, {});
			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("{b.output}"),
			);
		});
	});

	describe("integration scenarios spanning multiple variable types", () => {
		it("resolves a mixed prompt combining output, status, and dag args", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"Based on {research.output} (status: {research.status}), write in {dag.args.lang}",
				{ research: "Findings" },
				{ research: "completed" },
				{ lang: "TypeScript" },
			);
			expect(out).toBe(
				"Based on Findings (status: completed), write in TypeScript",
			);
		});

		it("resolves a full multi-step DAG prompt end-to-end", () => {
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"{a.output}\n---\n{b.output}\nlang={dag.args.lang}\nb-status={b.status}",
				{ a: "plan", b: "code" },
				{ b: "completed" },
				{ lang: "TS" },
			);
			expect(out).toBe(
				"plan\n---\ncode\nlang=TS\nb-status=completed",
			);
		});

		it("applies truncation within a mixed prompt only to oversized outputs", () => {
			const resolver = new TemplateResolver({ truncateChars: 5 });
			const out = resolver.resolve(
				"{a.output}|{b.output}|{c.status}",
				{ a: "AAAAAAAAAA", b: "ok" },
				{ c: "completed" },
				{},
			);
			expect(out).toBe(
				"AAAAA\n\n[... output truncated, 5 chars omitted ...]|ok|completed",
			);
		});

		it("treats the spec's research→code submission scenario faithfully", () => {
			// dag-submission spec: step "b" prompt "Code based on {a.output}"
			// after step "a" produced some research output.
			const resolver = new TemplateResolver();
			const out = resolver.resolve(
				"Code based on {a.output}",
				{ a: "Use OAuth2" },
				{},
				{},
			);
			expect(out).toBe("Code based on Use OAuth2");
		});
	});
});

import { describe, it, expect } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.3: Support `{<step-id>.output}` resolution from completed step
 * outputs.
 *
 * These tests assert the dedicated `{<step-id>.output}` interpolation
 * behaviour required by the `dag-execution` spec ("Template variable
 * resolution" → "Resolve upstream step output"). The resolver MUST expand
 * every `{<step-id>.output}` reference in a step prompt to the text output
 * captured for that completed step, using regex-based string interpolation
 * (design.md D3).
 *
 * Task 4.2 provided the generic `resolve()` surface; this file provides
 * exhaustive coverage of the output-reference arm in isolation.
 */
describe("TemplateResolver — {<step-id>.output} resolution (task 4.3)", () => {
	it("resolves a single upstream step output (spec scenario)", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Implement based on {a.output}",
			{ a: "Use JWT tokens" },
			{},
			{},
		);
		expect(out).toBe("Implement based on Use JWT tokens");
	});

	it("resolves multiple distinct step outputs in one prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{research.output}\n---\n{plan.output}",
			{ research: "Findings A", plan: "Plan B" },
			{},
			{},
		);
		expect(out).toBe("Findings A\n---\nPlan B");
	});

	it("resolves repeated references to the same step output", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.output} and again {a.output}",
			{ a: "X" },
			{},
			{},
		);
		expect(out).toBe("X and again X");
	});

	it("resolves step IDs containing underscores", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Use {data_fetch.output}",
			{ data_fetch: "rows" },
			{},
			{},
		);
		expect(out).toBe("Use rows");
	});

	it("resolves step IDs containing hyphens", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Use {data-fetch.output}",
			{ "data-fetch": "rows" },
			{},
			{},
		);
		expect(out).toBe("Use rows");
	});

	it("resolves step IDs containing digits", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Use {step1.output}",
			{ step1: "v1" },
			{},
			{},
		);
		expect(out).toBe("Use v1");
	});

	it("leaves the reference unresolved when the step has no recorded output", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("Use {missing.output}", {}, {}, {});
		expect(out).toBe("Use {missing.output}");
	});

	it("resolves to an empty string when the completed step output is empty", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("[{a.output}]", { a: "" }, {}, {});
		expect(out).toBe("[]");
	});

	it("preserves multi-line content in the resolved output", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Result:\n{a.output}",
			{ a: "line1\nline2\nline3" },
			{},
			{},
		);
		expect(out).toBe("Result:\nline1\nline2\nline3");
	});

	it("does not recursively expand template-like content in the output value", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.output}",
			{ a: "literal {b.output} text" },
			{ b: "SHOULD_NOT_APPEAR" },
			{},
		);
		expect(out).toBe("literal {b.output} text");
	});

	it("resolves a reference at the start of the prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("{a.output} tail", { a: "H" }, {}, {});
		expect(out).toBe("H tail");
	});

	it("resolves a reference at the end of the prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("head {a.output}", { a: "T" }, {}, {});
		expect(out).toBe("head T");
	});
});

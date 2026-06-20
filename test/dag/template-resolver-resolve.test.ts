import { describe, it, expect } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.2: Implement `resolve(prompt, stepOutputs, stepStatuses, dagArgs)`
 * — regex-based string interpolation.
 *
 * These tests assert the core contract of the `resolve()` method surface:
 * it accepts a prompt plus the three interpolation sources (per-step
 * outputs, per-step statuses, workflow-level dag args) and returns the
 * prompt with template variables expanded via regex-based string
 * interpolation (design.md D3).
 *
 * Detailed coverage of each variable type, truncation, and missing
 * reference handling is added by later tasks (4.3–4.7).
 */
describe("TemplateResolver.resolve (task 4.2 — regex interpolation)", () => {
	it("exposes a resolve() method", () => {
		const resolver = new TemplateResolver();
		expect(typeof resolver.resolve).toBe("function");
	});

	it("returns a string for a prompt with no template variables", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("plain prompt", {}, {}, {});
		expect(typeof out).toBe("string");
		expect(out).toBe("plain prompt");
	});

	it("performs regex-based string interpolation of a step output reference", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Implement based on {a.output}",
			{ a: "Use JWT tokens" },
			{},
			{},
		);
		expect(out).toBe("Implement based on Use JWT tokens");
	});

	it("performs regex-based string interpolation of a dag.args reference", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Write in {dag.args.lang}",
			{},
			{},
			{ lang: "TypeScript" },
		);
		expect(out).toBe("Write in TypeScript");
	});

	it("expands multiple references in a single prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.output} then {b.output} in {dag.args.lang}",
			{ a: "plan", b: "code" },
			{},
			{ lang: "TS" },
		);
		expect(out).toBe("plan then code in TS");
	});
});

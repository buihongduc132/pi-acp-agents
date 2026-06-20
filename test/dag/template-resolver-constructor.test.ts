import { describe, it, expect } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.1: Create `src/dag/template-resolver.ts` with `TemplateResolver` class.
 *
 * These tests assert only the construction/import behavior for task 4.1.
 * The full resolve() method surface (output / status / dag.args template
 * variables, truncation, missing-reference warnings) is covered by later
 * tasks (4.2–4.7).
 */
describe("TemplateResolver (constructor — task 4.1)", () => {
	it("exports the TemplateResolver class", () => {
		expect(typeof TemplateResolver).toBe("function");
	});

	it("constructs a TemplateResolver instance without throwing", () => {
		expect(() => new TemplateResolver()).not.toThrow();
	});

	it("returns a TemplateResolver instance", () => {
		const resolver = new TemplateResolver();
		expect(resolver).toBeInstanceOf(TemplateResolver);
	});
});

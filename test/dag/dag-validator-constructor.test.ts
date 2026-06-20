import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";

/**
 * Task 3.1: Create `src/dag/dag-validator.ts` with `DagValidator` class.
 *
 * These tests assert only the construction/import behavior for task 3.1.
 * The full validation method surface (validate / cycle detection /
 * dangling refs / duplicate IDs / agent availability / reserved IDs) is
 * covered by later tasks (3.2–3.8).
 */
describe("DagValidator (constructor — task 3.1)", () => {
	it("exports the DagValidator class", () => {
		expect(typeof DagValidator).toBe("function");
	});

	it("constructs a DagValidator instance without throwing", () => {
		expect(() => new DagValidator()).not.toThrow();
	});

	it("returns a DagValidator instance", () => {
		const validator = new DagValidator();
		expect(validator).toBeInstanceOf(DagValidator);
	});
});

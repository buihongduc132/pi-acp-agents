import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 3.5: Implement duplicate step ID detection — no two tasks in a
 * DAG definition SHALL share the same `id`.
 *
 * `dag-validator-validate.test.ts` (task 3.2) only loosely checks that two
 * identical IDs surface a single `duplicate step ID:` error. This file pins
 * the duplicate-ID contract precisely, aligned with the `dag-submission`
 * spec scenario:
 *
 *   WHEN the LLM submits a DAG with two tasks having `id: "research"`
 *   THEN the system SHALL reject with error (suffix):
 *        `duplicate step ID: "research"`
 *   (the `DAG validation failed: ` wrapper is prepended by the tool layer)
 *
 * Coverage:
 *  - exact spec-scenario error string
 *  - simple pair duplicate (two identical IDs → one error)
 *  - triple duplicate (same ID three times → STILL one error, deduplicated)
 *  - multiple distinct duplicate IDs (all reported, each exactly once)
 *  - duplicate ID reported even when surrounded by other violations
 *  - a unique-ID DAG produces NO duplicate errors (no false positives)
 *  - duplicate detection is case-sensitive ("A" !== "a")
 *  - duplicate detection is order-independent
 *  - duplicate ID embedded mid-list is still detected
 *  - exactly ONE error is emitted per duplicated ID (no over-reporting)
 */
describe("DagValidator duplicate step ID detection (task 3.5)", () => {
	const agents = new Set(["gemini", "codex"]);
	const v = () => new DagValidator();

	const task = (
		id: string,
		overrides: Partial<DagTaskDefinition> = {},
	): DagTaskDefinition => ({
		id,
		agent: "gemini",
		prompt: "p",
		...overrides,
	});

	it("reports the exact spec scenario: 'duplicate step ID: \"research\"'", () => {
		const tasks = [task("research"), task("research")];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('duplicate step ID: "research"');
	});

	it("flags a simple pair of identical IDs", () => {
		const tasks = [task("a"), task("a")];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('duplicate step ID: "a"');
	});

	it("reports exactly ONE error when an ID appears three times", () => {
		const tasks = [task("a"), task("a"), task("a")];
		const result = v().validate(tasks, agents);
		const dupErrors = result.errors.filter((e) =>
			e.startsWith("duplicate step ID:"),
		);
		expect(dupErrors).toEqual(['duplicate step ID: "a"']);
		expect(dupErrors.length).toBe(1);
	});

	it("reports each distinct duplicate ID exactly once", () => {
		// "a" appears twice, "b" appears twice, "c" once.
		const tasks = [task("a"), task("b"), task("a"), task("b"), task("c")];
		const result = v().validate(tasks, agents);
		const dupErrors = result.errors.filter((e) =>
			e.startsWith("duplicate step ID:"),
		);
		expect(dupErrors.length).toBe(2);
		expect(dupErrors).toContain('duplicate step ID: "a"');
		expect(dupErrors).toContain('duplicate step ID: "b"');
	});

	it("still reports the duplicate ID when other violations are present", () => {
		// "a" duplicated, plus an unknown agent, plus a dangling ref.
		const tasks = [
			task("a", { agent: "ghost" }),
			task("a", { dependsOn: ["missing"] }),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('duplicate step ID: "a"');
		expect(result.errors.some((e) => e.startsWith("duplicate step ID:"))).toBe(true);
	});

	it("does NOT flag a DAG where every ID is unique", () => {
		const tasks = [
			task("a"),
			task("b", { dependsOn: ["a"] }),
			task("c", { dependsOn: ["a"] }),
			task("d", { dependsOn: ["b", "c"] }),
		];
		const result = v().validate(tasks, agents);
		expect(
			result.errors.filter((e) => e.startsWith("duplicate step ID:")),
		).toEqual([]);
	});

	it("treats IDs case-sensitively ('A' and 'a' are distinct)", () => {
		const tasks = [task("A"), task("a")];
		const result = v().validate(tasks, agents);
		expect(
			result.errors.filter((e) => e.startsWith("duplicate step ID:")),
		).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("detects duplicates regardless of task declaration order", () => {
		// Interleaved declaration of two pairs.
		const tasks = [task("x"), task("y"), task("x"), task("y")];
		const result = v().validate(tasks, agents);
		const dupErrors = result.errors.filter((e) =>
			e.startsWith("duplicate step ID:"),
		);
		expect(dupErrors).toContain('duplicate step ID: "x"');
		expect(dupErrors).toContain('duplicate step ID: "y"');
	});

	it("detects a duplicate ID embedded in the middle of the list", () => {
		const tasks = [
			task("alpha"),
			task("beta"),
			task("alpha"), // duplicate, not adjacent to first
			task("gamma"),
		];
		const result = v().validate(tasks, agents);
		expect(result.errors).toContain('duplicate step ID: "alpha"');
	});

	it("does NOT over-report: one duplicated ID yields exactly one error", () => {
		const tasks = [task("z"), task("z")];
		const result = v().validate(tasks, agents);
		const dupErrors = result.errors.filter((e) =>
			e.startsWith("duplicate step ID:"),
		);
		expect(dupErrors.length).toBe(1);
	});
});

import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 3.4: Implement dangling reference detection — all `dependsOn`
 * targets must exist in the task list.
 *
 * `dag-validator-validate.test.ts` (task 3.2) only loosely checks that a
 * single dangling dependency surfaces *some* `dangling reference:` error.
 * This file pins the dangling-reference contract precisely, aligned with
 * the `dag-submission` spec scenario:
 *
 *   WHEN task "b" has `dependsOn: ["x"]` but no task with id "x" exists
 *   THEN the system SHALL reject with error (suffix):
 *        `dangling reference: task "b" depends on unknown step "x"`
 *   (the `DAG validation failed: ` wrapper is prepended by the tool layer)
 *
 * Coverage:
 *  - exact spec-scenario error string
 *  - single dangling ref on a single task
 *  - multiple dangling refs on ONE task (one error per missing target)
 *  - dangling refs across MULTIPLE tasks (all reported)
 *  - dangling ref at the LEAF of an otherwise-valid chain
 *  - a fully-resolved DAG produces NO dangling errors (no false positives)
 *  - a self-reference (a depends on "a") is NOT a dangling ref (id exists)
 *  - a dangling ref does NOT masquerade as a cycle
 *  - reporting is stable regardless of task declaration order
 */
describe("DagValidator dangling reference detection (task 3.4)", () => {
	const agents = new Set(["gemini", "codex"]);
	const v = () => new DagValidator();

	const task = (
		id: string,
		dependsOn: string[] = [],
	): DagTaskDefinition => ({
		id,
		agent: "gemini",
		prompt: "p",
		dependsOn,
	});

	it("reports the exact spec scenario: 'dangling reference: task \"b\" depends on unknown step \"x\"'", () => {
		const tasks = [task("b", ["x"])];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'dangling reference: task "b" depends on unknown step "x"',
		);
	});

	it("flags a single dangling dependency", () => {
		const tasks = [
			task("a"),
			task("b", ["a", "ghost"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'dangling reference: task "b" depends on unknown step "ghost"',
		);
	});

	it("reports one error per missing target when a task has multiple dangling refs", () => {
		const tasks = [task("a", ["x", "y", "z"])];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'dangling reference: task "a" depends on unknown step "x"',
		);
		expect(result.errors).toContain(
			'dangling reference: task "a" depends on unknown step "y"',
		);
		expect(result.errors).toContain(
			'dangling reference: task "a" depends on unknown step "z"',
		);
	});

	it("reports dangling refs across multiple tasks", () => {
		const tasks = [
			task("a", ["nope1"]),
			task("b", ["nope2"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'dangling reference: task "a" depends on unknown step "nope1"',
		);
		expect(result.errors).toContain(
			'dangling reference: task "b" depends on unknown step "nope2"',
		);
	});

	it("flags a dangling ref at the leaf of an otherwise-valid chain", () => {
		// a → b → c → missing
		const tasks = [
			task("c", ["missing"]),
			task("b", ["c"]),
			task("a", ["b"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'dangling reference: task "c" depends on unknown step "missing"',
		);
		// Resolved edges must NOT be reported as dangling.
		expect(result.errors).not.toContain(
			'dangling reference: task "b" depends on unknown step "c"',
		);
		expect(result.errors).not.toContain(
			'dangling reference: task "a" depends on unknown step "b"',
		);
	});

	it("does NOT flag a fully-resolved diamond DAG (a → {b,c} → d)", () => {
		const tasks = [
			task("a"),
			task("b", ["a"]),
			task("c", ["a"]),
			task("d", ["b", "c"]),
		];
		const result = v().validate(tasks, agents);
		const dangling = result.errors.filter((e) =>
			e.startsWith("dangling reference:"),
		);
		expect(dangling).toEqual([]);
	});

	it("does NOT flag a self-reference (a depends on a) as dangling", () => {
		// "a" exists in the task list, so the reference resolves. (Cycle
		// detection handles the self-loop separately; here we only assert
		// no dangling error is emitted for it.)
		const tasks = [task("a", ["a"])];
		const result = v().validate(tasks, agents);
		expect(
			result.errors.filter((e) => e.startsWith("dangling reference:")),
		).toEqual([]);
	});

	it("does NOT let a dangling ref masquerade as a cycle", () => {
		const tasks = [task("a", ["x"])];
		const result = v().validate(tasks, agents);
		expect(
			result.errors.some((e) => e.startsWith("cycle detected:")),
		).toBe(false);
		expect(
			result.errors.some((e) => e.startsWith("dangling reference:")),
		).toBe(true);
	});

	it("detects dangling refs regardless of task declaration order", () => {
		// "b" is declared before "a"; "a" exists, "ghost" does not.
		const tasks = [task("b", ["a", "ghost"]), task("a")];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'dangling reference: task "b" depends on unknown step "ghost"',
		);
		expect(result.errors).not.toContain(
			'dangling reference: task "b" depends on unknown step "a"',
		);
	});
});

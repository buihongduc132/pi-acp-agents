import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 3.3: Implement cycle detection via DFS (aligned with the
 * `AcpTaskStore.findDependencyPath()` pattern).
 *
 * `dag-validator-validate.test.ts` (task 3.2) only loosely checks that a
 * cycle produces *some* `cycle detected:` error mentioning the involved
 * node IDs. This file pins the DFS cycle-detection contract precisely:
 *
 *  - exact error-string format `cycle detected: <path> → <entry>`
 *    matching the `dag-submission` spec scenario
 *    (`cycle detected: a → b → a`)
 *  - cycles of length > 2 report the full closed-loop path in dependency
 *    order (a → b → c → a)
 *  - self-loops (a depends on a) are detected
 *  - acyclic graphs (linear chain, diamond) produce NO false positives
 *  - a cycle nested inside a larger graph is still surfaced
 *  - only the FIRST cycle is reported (deterministic, one error)
 *
 * The DFS walks the `dependsOn` edges (node → its dependency), matching
 * `AcpTaskStore.findDependencyPath()` which walks `blockedBy` edges —
 * both follow the dependency direction.
 */
describe("DagValidator cycle detection via DFS (task 3.3)", () => {
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

	it("reports the exact spec scenario: 'cycle detected: a → b → a'", () => {
		const tasks = [task("a", ["b"]), task("b", ["a"])];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("cycle detected: a → b → a");
	});

	it("reports the full closed-loop path for a 3-node cycle", () => {
		// a → b → c → a  (a depends on b, b on c, c on a)
		const tasks = [
			task("a", ["b"]),
			task("b", ["c"]),
			task("c", ["a"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("cycle detected: a → b → c → a");
	});

	it("detects a self-loop (a depends on a)", () => {
		const tasks = [task("a", ["a"])];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.startsWith("cycle detected:"))).toBe(true);
		expect(result.errors.some((e) => e.includes("a"))).toBe(true);
	});

	it("does NOT flag a linear chain (a → b → c) as cyclic", () => {
		const tasks = [
			task("c"),
			task("b", ["c"]),
			task("a", ["b"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(true);
		expect(result.errors.every((e) => !e.startsWith("cycle detected:"))).toBe(true);
	});

	it("does NOT flag a diamond DAG (a → {b,c} → d) as cyclic", () => {
		const tasks = [
			task("a"),
			task("b", ["a"]),
			task("c", ["a"]),
			task("d", ["b", "c"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(true);
		expect(result.errors.every((e) => !e.startsWith("cycle detected:"))).toBe(true);
	});

	it("detects a cycle nested inside a larger acyclic graph", () => {
		// a → b → c → b  (cycle b↔c), plus independent d → e chain and
		// an entry node x that feeds a.
		const tasks = [
			task("x"),
			task("a", ["x"]),
			task("b", ["a", "c"]),
			task("c", ["b"]),
			task("d"),
			task("e", ["d"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.startsWith("cycle detected:"))).toBe(true);
		// The closed loop must mention both b and c.
		const cycleErr = result.errors.find((e) => e.startsWith("cycle detected:"));
		expect(cycleErr).toBeDefined();
		expect(cycleErr).toContain("b");
		expect(cycleErr).toContain("c");
	});

	it("reports only the first cycle deterministically (one error)", () => {
		// Two disjoint cycles: a↔b and c↔d.
		const tasks = [
			task("a", ["b"]),
			task("b", ["a"]),
			task("c", ["d"]),
			task("d", ["c"]),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		const cycleErrors = result.errors.filter((e) =>
			e.startsWith("cycle detected:"),
		);
		expect(cycleErrors.length).toBe(1);
	});

	it("ignores dangling edges during cycle detection (handled separately)", () => {
		// a depends on unknown "x" — no cycle should be fabricated.
		const tasks = [task("a", ["x"])];
		const result = v().validate(tasks, agents);
		expect(result.errors.every((e) => !e.startsWith("cycle detected:"))).toBe(true);
	});
});

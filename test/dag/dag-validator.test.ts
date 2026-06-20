/**
 * Task 3.8: Consolidated unit tests for DagValidator.
 *
 * This is the umbrella test for static DAG validation
 * (`src/dag/dag-validator.ts`). It exercises the full public surface of
 * `DagValidator.validate()` end-to-end across all 5 validation rules
 * declared in the `dag-submission` spec ("Static validation before
 * execution") plus the valid-DAG pass-through contract, and asserts the
 * on-disk-independent behaviour from design.md (D6 file layout, risk R4
 * reserved prefixes) and the per-violation error-string format pinned by
 * the spec scenarios:
 *
 *   - cycle:           `cycle detected: a → b → a`
 *   - dangling ref:    `dangling reference: task "b" depends on unknown step "x"`
 *   - duplicate id:    `duplicate step ID: "research"`
 *   - unknown agent:   `unknown agent: "unknown-agent"`
 *   - reserved id:     `reserved step ID: "dag"`
 *
 * The per-rule test files (dag-validator-cycle-detection.test.ts, etc.)
 * drove the RED phase of tasks 3.3–3.7 with deep per-rule coverage. This
 * file is the integration-style coverage that ties the whole validator
 * together: it guards against regressions that span multiple rules
 * (e.g. error aggregation, ordering, valid-DAG pass-through, gate/option
 * fields ignored by validation, agent-set shape flexibility).
 */

import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

describe("DagValidator — consolidated (task 3.8)", () => {
	const agents = ["gemini", "codex", "custom-agent"];
	const v = () => new DagValidator();

	// ---------------------------------------------------------------------------
	// Valid DAG pass-through
	// ---------------------------------------------------------------------------

	describe("valid DAG pass-through", () => {
		it("accepts a simple 2-step linear DAG with no violations", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "Research X" },
				{
					id: "b",
					agent: "codex",
					prompt: "Code based on {a.output}",
					dependsOn: ["a"],
				},
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it("accepts a diamond DAG (a → [b, c] → d) with parallel branches", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "p" },
				{ id: "b", agent: "codex", prompt: "p", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "p", dependsOn: ["a"] },
				{ id: "d", agent: "codex", prompt: "p", dependsOn: ["b", "c"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it("accepts an empty task list", () => {
			const result = v().validate([], agents);
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it("accepts a single-task DAG with no dependencies", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "solo", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it("accepts a valid DAG that uses `gate` and template vars (validation ignores them)", () => {
			const tasks: DagTaskDefinition[] = [
				{
					id: "research",
					agent: "gemini",
					prompt: "Research {dag.args.topic}",
				},
				{
					id: "review",
					agent: "codex",
					prompt: "Review {research.output}",
					dependsOn: ["research"],
					gate: "after",
				},
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it("accepts agentNames provided as a Set<string>", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, new Set(agents));
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it("accepts agentNames provided as a string[]", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});
	});

	// ---------------------------------------------------------------------------
	// Rule 1: duplicate step ID detection
	// ---------------------------------------------------------------------------

	describe("duplicate step ID detection", () => {
		it("rejects a DAG with two tasks sharing the same id", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "research", agent: "gemini", prompt: "p" },
				{ id: "research", agent: "codex", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('duplicate step ID: "research"');
		});

		it("reports a duplicate id exactly once even with >2 occurrences", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "dup", agent: "gemini", prompt: "p" },
				{ id: "dup", agent: "codex", prompt: "p" },
				{ id: "dup", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			const dupErrors = result.errors.filter((e) => e.startsWith("duplicate step ID"));
			expect(dupErrors).toEqual(['duplicate step ID: "dup"']);
		});
	});

	// ---------------------------------------------------------------------------
	// Rule 2: reserved step ID rejection
	// ---------------------------------------------------------------------------

	describe("reserved step ID rejection", () => {
		it("rejects id `dag` (collides with {dag.args.*})", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "dag", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('reserved step ID: "dag"');
		});

		it("rejects id `step`", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "step", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('reserved step ID: "step"');
		});

		it("rejects id `agent`", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "agent", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('reserved step ID: "agent"');
		});

		it("reports each reserved id once when several collide in the same DAG", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "dag", agent: "gemini", prompt: "p" },
				{ id: "step", agent: "gemini", prompt: "p" },
				{ id: "agent", agent: "gemini", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.errors).toContain('reserved step ID: "dag"');
			expect(result.errors).toContain('reserved step ID: "step"');
			expect(result.errors).toContain('reserved step ID: "agent"');
		});
	});

	// ---------------------------------------------------------------------------
	// Rule 3: dangling reference detection
	// ---------------------------------------------------------------------------

	describe("dangling reference detection", () => {
		it("rejects a dependsOn entry pointing at a non-existent step", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "b", agent: "gemini", prompt: "p", dependsOn: ["x"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				'dangling reference: task "b" depends on unknown step "x"',
			);
		});

		it("reports every dangling dependency separately", () => {
			const tasks: DagTaskDefinition[] = [
				{
					id: "b",
					agent: "gemini",
					prompt: "p",
					dependsOn: ["x", "y"],
				},
			];
			const result = v().validate(tasks, agents);
			expect(result.errors).toContain(
				'dangling reference: task "b" depends on unknown step "x"',
			);
			expect(result.errors).toContain(
				'dangling reference: task "b" depends on unknown step "y"',
			);
		});

		it("does not flag a self-reference as dangling (cycle rule owns that)", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "p", dependsOn: ["a"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.errors.some((e) => e.startsWith("dangling reference"))).toBe(false);
		});
	});

	// ---------------------------------------------------------------------------
	// Rule 4: agent availability check
	// ---------------------------------------------------------------------------

	describe("agent availability check", () => {
		it("rejects a task referencing an unconfigured agent", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "unknown-agent", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('unknown agent: "unknown-agent"');
		});

		it("does not false-positive on configured agents (incl. hyphenated names)", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "custom-agent", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			expect(result.errors.some((e) => e.startsWith("unknown agent"))).toBe(false);
		});

		it("reports a distinct unknown agent once even if referenced by multiple tasks", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "ghost", prompt: "p" },
				{ id: "b", agent: "ghost", prompt: "p" },
			];
			const result = v().validate(tasks, agents);
			const agentErrors = result.errors.filter((e) => e.startsWith("unknown agent"));
			expect(agentErrors).toEqual(['unknown agent: "ghost"']);
		});
	});

	// ---------------------------------------------------------------------------
	// Rule 5: cycle detection (DFS)
	// ---------------------------------------------------------------------------

	describe("cycle detection via DFS", () => {
		it("rejects a 2-node cycle with the spec error format", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "p", dependsOn: ["b"] },
				{ id: "b", agent: "gemini", prompt: "p", dependsOn: ["a"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("cycle detected: a → b → a");
		});

		it("rejects a self-loop (a depends on a)", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "p", dependsOn: ["a"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.startsWith("cycle detected:"))).toBe(true);
		});

		it("does not false-positive on an acyclic diamond", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "gemini", prompt: "p" },
				{ id: "b", agent: "codex", prompt: "p", dependsOn: ["a"] },
				{ id: "c", agent: "gemini", prompt: "p", dependsOn: ["a"] },
				{ id: "d", agent: "codex", prompt: "p", dependsOn: ["b", "c"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.errors.some((e) => e.startsWith("cycle detected:"))).toBe(false);
			expect(result.valid).toBe(true);
		});
	});

	// ---------------------------------------------------------------------------
	// Cross-rule aggregation & ordering
	// ---------------------------------------------------------------------------

	describe("multiple violations aggregate into errors[]", () => {
		it("reports duplicate id + dangling ref + unknown agent together", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "a", agent: "nope", prompt: "p" },
				{ id: "a", agent: "gemini", prompt: "p", dependsOn: ["ghost"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('duplicate step ID: "a"');
			expect(result.errors).toContain(
				'dangling reference: task "a" depends on unknown step "ghost"',
			);
			expect(result.errors).toContain('unknown agent: "nope"');
			expect(result.errors.length).toBeGreaterThanOrEqual(3);
		});

		it("keeps valid === false and errors.length > 0 whenever any rule fires", () => {
			const tasks: DagTaskDefinition[] = [
				{ id: "step", agent: "ghost", prompt: "p", dependsOn: ["missing"] },
			];
			const result = v().validate(tasks, agents);
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it("structural checks (duplicate/reserved) precede graph checks in the output", () => {
			// A DAG that violates both a structural rule (reserved id) and a
			// graph rule (cycle). Whichever order, valid must be false and
			// both messages must be present — but structural errors are
			// emitted before graph traversal errors by the checks() pipeline.
			const tasks: DagTaskDefinition[] = [
				{ id: "dag", agent: "gemini", prompt: "p", dependsOn: ["b"] },
				{ id: "b", agent: "gemini", prompt: "p", dependsOn: ["dag"] },
			];
			const result = v().validate(tasks, agents);
			const reservedIdx = result.errors.findIndex((e) => e.startsWith("reserved step ID"));
			const cycleIdx = result.errors.findIndex((e) => e.startsWith("cycle detected"));
			expect(reservedIdx).toBeGreaterThanOrEqual(0);
			expect(cycleIdx).toBeGreaterThanOrEqual(0);
			expect(reservedIdx).toBeLessThan(cycleIdx);
		});
	});
});

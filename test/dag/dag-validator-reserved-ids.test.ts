import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 3.7: Implement reserved step ID rejection — reject IDs matching
 * `dag`, `step`, `agent`.
 *
 * `dag-validator-validate.test.ts` (task 3.2) loosely checks that the
 * three reserved IDs surface a `reserved step ID:` error. This file pins
 * the reserved-ID contract precisely, aligned with the `dag-submission`
 * spec scenario:
 *
 *   WHEN the LLM submits a DAG with a step `id: "dag"` or `id: "step"`
 *        or `id: "agent"`
 *   THEN the system SHALL reject with error (suffix):
 *        `reserved step ID: "dag"`
 *   (the `DAG validation failed: ` wrapper is prepended by the tool layer)
 *
 * Rationale (design.md R4): step IDs matching reserved template-variable
 * prefixes would cause collisions in TemplateResolver, where `{dag.args.*}`
 * is a valid template expression. Rejecting these IDs at validation time
 * prevents ambiguity at resolution time.
 *
 * Coverage:
 *  - exact spec-scenario error string for "dag"
 *  - exact spec-scenario error string for "step"
 *  - exact spec-scenario error string for "agent"
 *  - all three reserved IDs in one DAG → three distinct errors
 *  - a single reserved ID → exactly one reserved error
 *  - non-reserved IDs produce NO reserved errors (no false positives)
 *  - reserved detection is case-sensitive ("DAG" is allowed, "dag" is not)
 *  - reserved IDs are reported alongside other violations
 *  - deduplication: same reserved ID used twice → STILL one reserved error
 *  - reserved IDs do NOT interfere with duplicate ID detection
 *  - substring IDs ("dag-step", "my-step") are NOT rejected (exact match only)
 *  - a DAG with only non-reserved IDs is valid (reserved check alone)
 */
describe("DagValidator reserved step ID rejection (task 3.7)", () => {
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

	it("rejects step id 'dag' with exact spec-scenario error", () => {
		const tasks = [task("dag")];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('reserved step ID: "dag"');
	});

	it("rejects step id 'step' with exact spec-scenario error", () => {
		const tasks = [task("step")];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('reserved step ID: "step"');
	});

	it("rejects step id 'agent' with exact spec-scenario error", () => {
		const tasks = [task("agent")];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('reserved step ID: "agent"');
	});

	it("reports all three reserved IDs when all are present", () => {
		const tasks = [
			task("dag"),
			task("step"),
			task("agent"),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		const reservedErrors = result.errors.filter((e) =>
			e.startsWith("reserved step ID:"),
		);
		expect(reservedErrors.length).toBe(3);
		expect(reservedErrors).toContain('reserved step ID: "dag"');
		expect(reservedErrors).toContain('reserved step ID: "step"');
		expect(reservedErrors).toContain('reserved step ID: "agent"');
	});

	it("produces NO reserved errors for non-reserved IDs (no false positives)", () => {
		const tasks = [
			task("research"),
			task("plan", { dependsOn: ["research"] }),
			task("code", { dependsOn: ["plan"] }),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(true);
		expect(
			result.errors.filter((e) => e.startsWith("reserved step ID:")),
		).toEqual([]);
	});

	it("is case-sensitive: 'DAG' and 'Step' are NOT reserved", () => {
		const tasks = [task("DAG"), task("Step"), task("Agent")];
		const result = v().validate(tasks, agents);
		expect(
			result.errors.filter((e) => e.startsWith("reserved step ID:")),
		).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("reports reserved IDs alongside other violations", () => {
		// "dag" is reserved, and "x" has an unknown agent.
		const tasks = [
			task("dag"),
			task("x", { agent: "ghost" }),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('reserved step ID: "dag"');
		expect(result.errors).toContain('unknown agent: "ghost"');
	});

	it("deduplicates: same reserved ID used twice → STILL one reserved error", () => {
		const tasks = [task("dag"), task("dag")];
		const result = v().validate(tasks, agents);
		const reservedErrors = result.errors.filter((e) =>
			e.startsWith("reserved step ID:"),
		);
		expect(reservedErrors).toEqual(['reserved step ID: "dag"']);
		// Also reports the duplicate (separate check).
		expect(result.errors).toContain('duplicate step ID: "dag"');
	});

	it("does NOT reject IDs that merely contain a reserved word as a substring", () => {
		// "dag-step", "mystep", "my-agent" should all be allowed.
		const tasks = [
			task("dag-step"),
			task("mystep"),
			task("my-agent"),
			task("dagtask"),
			task("step1"),
			task("agent-pool"),
		];
		const result = v().validate(tasks, agents);
		expect(
			result.errors.filter((e) => e.startsWith("reserved step ID:")),
		).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("reports exactly ONE reserved error per unique reserved ID", () => {
		// Three tasks with id "step" — still only one reserved error.
		const tasks = [task("step"), task("step"), task("step")];
		const result = v().validate(tasks, agents);
		const reservedErrors = result.errors.filter((e) =>
			e.startsWith("reserved step ID:"),
		);
		expect(reservedErrors).toEqual(['reserved step ID: "step"']);
	});

	it("reserved IDs with valid dependencies still get rejected", () => {
		// Even if "dag" has valid deps, the ID itself is forbidden.
		const tasks = [
			task("a"),
			task("dag", { dependsOn: ["a"] }),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('reserved step ID: "dag"');
	});
});

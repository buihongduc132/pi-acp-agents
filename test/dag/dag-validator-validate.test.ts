import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 3.2: Implement `validate(tasks, agentNames)` — returns
 * `{valid: boolean, errors: string[]}`.
 *
 * These tests pin the public contract of `DagValidator.validate()`:
 *  - accepts `agentNames` as either a `Set<string>` or `string[]`
 *  - returns `{valid: true, errors: []}` for a well-formed DAG
 *  - returns `{valid: false, errors: [...]}` for an invalid DAG, with
 *    per-violation messages (one per problem) and `valid === errors.length === 0`
 *
 * The individual rule implementations (cycle / dangling / duplicate /
 * agent / reserved) are exercised here at the public-API level; tasks
 * 3.3–3.7 add dedicated per-rule coverage and 3.8 consolidates them.
 */
describe("DagValidator.validate (task 3.2)", () => {
	const agents = ["gemini", "codex"];

	const validTasks: DagTaskDefinition[] = [
		{ id: "a", agent: "gemini", prompt: "Research X" },
		{
			id: "b",
			agent: "codex",
			prompt: "Code based on {a.output}",
			dependsOn: ["a"],
		},
	];

	it("returns {valid: true, errors: []} for a well-formed linear DAG (agentNames as array)", () => {
		const result = new DagValidator().validate(validTasks, agents);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("accepts agentNames as a Set<string>", () => {
		const result = new DagValidator().validate(validTasks, new Set(agents));
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("returns {valid: true, errors: []} for an empty DAG", () => {
		const result = new DagValidator().validate([], agents);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("derives valid from errors.length (valid === errors.length === 0)", () => {
		const bad: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "p" },
			{ id: "a", agent: "gemini", prompt: "p" },
		];
		const result = new DagValidator().validate(bad, agents);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.valid).toBe(false);
	});

	it("detects a cycle and reports the path", () => {
		const cyclic: DagTaskDefinition[] = [
			{ id: "a", agent: "gemini", prompt: "p", dependsOn: ["b"] },
			{ id: "b", agent: "gemini", prompt: "p", dependsOn: ["a"] },
		];
		const result = new DagValidator().validate(cyclic, agents);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.startsWith("cycle detected:"))).toBe(true);
		expect(result.errors.some((e) => e.includes("a") && e.includes("b"))).toBe(true);
	});

	it("detects dangling references", () => {
		const dangling: DagTaskDefinition[] = [
			{ id: "b", agent: "gemini", prompt: "p", dependsOn: ["x"] },
		];
		const result = new DagValidator().validate(dangling, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'dangling reference: task "b" depends on unknown step "x"',
		);
	});

	it("detects duplicate step IDs", () => {
		const dup: DagTaskDefinition[] = [
			{ id: "research", agent: "gemini", prompt: "p" },
			{ id: "research", agent: "gemini", prompt: "p" },
		];
		const result = new DagValidator().validate(dup, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('duplicate step ID: "research"');
	});

	it("detects unknown agents", () => {
		const unknown: DagTaskDefinition[] = [
			{ id: "a", agent: "unknown-agent", prompt: "p" },
		];
		const result = new DagValidator().validate(unknown, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('unknown agent: "unknown-agent"');
	});

	it("rejects reserved step IDs (dag, step, agent)", () => {
		const reserved: DagTaskDefinition[] = [
			{ id: "dag", agent: "gemini", prompt: "p" },
			{ id: "step", agent: "gemini", prompt: "p" },
			{ id: "agent", agent: "gemini", prompt: "p" },
		];
		const result = new DagValidator().validate(reserved, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('reserved step ID: "dag"');
		expect(result.errors).toContain('reserved step ID: "step"');
		expect(result.errors).toContain('reserved step ID: "agent"');
	});

	it("aggregates multiple violations into the errors array", () => {
		const messy: DagTaskDefinition[] = [
			{ id: "a", agent: "nope", prompt: "p" },
			{ id: "a", agent: "gemini", prompt: "p", dependsOn: ["ghost"] },
		];
		const result = new DagValidator().validate(messy, agents);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
	});
});

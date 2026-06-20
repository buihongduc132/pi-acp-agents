import { describe, it, expect } from "vitest";
import { DagValidator } from "../../src/dag/dag-validator.js";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 3.6: Implement agent availability check — all referenced agents
 * must exist in the `agent_servers` config set.
 *
 * `dag-validator-validate.test.ts` (task 3.2) only loosely checks that a
 * single unknown agent surfaces one `unknown agent:` error. This file pins
 * the agent-availability contract precisely, aligned with the
 * `dag-submission` spec scenario:
 *
 *   WHEN the LLM submits a DAG with `agent: "unknown-agent"` and no such
 *        agent exists in `agent_servers` config
 *   THEN the system SHALL reject with error (suffix):
 *        `unknown agent: "unknown-agent"`
 *   (the `DAG validation failed: ` wrapper is prepended by the tool layer)
 *
 * Coverage:
 *  - exact spec-scenario error string
 *  - one unknown agent among many tasks → exactly one error
 *  - multiple distinct unknown agents → one error per unknown agent
 *  - same unknown agent referenced by multiple tasks → STILL one error
 *    (deduplicated, like duplicate/reserved ID reporting)
 *  - accepts agentNames as a Set<string> (the validator's public contract)
 *  - accepts agentNames as string[] (caller convenience)
 *  - empty agent set → every agent referenced is unknown
 *  - all agents present → NO agent-availability errors (no false positives)
 *  - detection is case-sensitive ("Gemini" !== "gemini")
 *  - agent availability is reported alongside other violations
 *  - an empty DAG with non-empty agent set is still valid
 */
describe("DagValidator agent availability check (task 3.6)", () => {
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

	it("reports the exact spec scenario: 'unknown agent: \"unknown-agent\"'", () => {
		const tasks = [task("a", { agent: "unknown-agent" })];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('unknown agent: "unknown-agent"');
	});

	it("flags one unknown agent referenced by multiple tasks exactly once", () => {
		const tasks = [
			task("a", { agent: "ghost" }),
			task("b", { agent: "ghost" }),
			task("c", { agent: "gemini" }),
		];
		const result = v().validate(tasks, agents);
		const agentErrors = result.errors.filter((e) =>
			e.startsWith("unknown agent:"),
		);
		expect(agentErrors).toEqual(['unknown agent: "ghost"']);
		expect(agentErrors.length).toBe(1);
	});

	it("reports each distinct unknown agent exactly once", () => {
		const tasks = [
			task("a", { agent: "ghost" }),
			task("b", { agent: "phantom" }),
			task("c", { agent: "gemini" }),
		];
		const result = v().validate(tasks, agents);
		const agentErrors = result.errors.filter((e) =>
			e.startsWith("unknown agent:"),
		);
		expect(agentErrors.length).toBe(2);
		expect(agentErrors).toContain('unknown agent: "ghost"');
		expect(agentErrors).toContain('unknown agent: "phantom"');
	});

	it("accepts agentNames as a string[]", () => {
		const tasks = [task("a", { agent: "nope" })];
		const result = v().validate(tasks, ["gemini", "codex"]);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('unknown agent: "nope"');
	});

	it("flags every referenced agent when the configured agent set is empty", () => {
		const emptyAgents = new Set<string>();
		const tasks = [
			task("a", { agent: "gemini" }),
			task("b", { agent: "codex" }),
		];
		const result = v().validate(tasks, emptyAgents);
		expect(result.valid).toBe(false);
		const agentErrors = result.errors.filter((e) =>
			e.startsWith("unknown agent:"),
		);
		expect(agentErrors.length).toBe(2);
		expect(agentErrors).toContain('unknown agent: "gemini"');
		expect(agentErrors).toContain('unknown agent: "codex"');
	});

	it("does NOT flag a DAG where every agent is configured (no false positives)", () => {
		const tasks = [
			task("a", { agent: "gemini" }),
			task("b", { agent: "codex", dependsOn: ["a"] }),
			task("c", { agent: "gemini", dependsOn: ["a"] }),
		];
		const result = v().validate(tasks, agents);
		expect(
			result.errors.filter((e) => e.startsWith("unknown agent:")),
		).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("treats agent names case-sensitively ('Gemini' !== 'gemini')", () => {
		const tasks = [task("a", { agent: "Gemini" })];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('unknown agent: "Gemini"');
	});

	it("reports unknown agents alongside other violations", () => {
		const tasks = [
			task("a", { agent: "ghost", dependsOn: ["missing"] }),
		];
		const result = v().validate(tasks, agents);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('unknown agent: "ghost"');
		expect(
			result.errors.some((e) => e.startsWith("dangling reference:")),
		).toBe(true);
	});

	it("accepts an empty DAG even when the agent set is empty", () => {
		const emptyAgents = new Set<string>();
		const result = v().validate([], emptyAgents);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

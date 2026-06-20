/**
 * DagValidator — static validation of a DAG definition before execution.
 *
 * Runs ahead of any dispatch: cycle detection (DFS), dangling-reference
 * detection, duplicate step ID detection, agent availability check, and
 * reserved step ID rejection. Aligned with the `dag-submission` spec
 * ("Static validation before execution") and design.md risk R4
 * (template-variable collision on reserved prefixes).
 *
 * The `validate()` method is the public entry point (task 3.2). It
 * normalises the agent set, runs an ordered pipeline of internal checks,
 * and returns `{valid, errors}`. Each per-violation `errors[i]` carries
 * the suffix documented in the spec (e.g. `cycle detected: a → b → a`);
 * the tool layer prepends the `DAG validation failed: ` wrapper.
 *
 * Tasks 3.3–3.7 add dedicated per-rule test coverage and may extract the
 * inline checks into named helpers; task 3.8 consolidates coverage.
 */

import type { DagTaskDefinition } from "../config/types.js";

/** Result of validating a DAG definition. */
export interface DagValidationResult {
	/** `true` when the definition has no violations. */
	valid: boolean;
	/** Human-readable violation messages (one per detected problem). */
	errors: string[];
}

/** Step IDs reserved for template variables; cannot be used as task IDs. */
const RESERVED_STEP_IDS = new Set(["dag", "step", "agent"]);

export class DagValidator {
	/**
	 * Validate a DAG task definition against the configured agent set.
	 *
	 * @param tasks     The declarative DAG task list from `acp_dag_submit`.
	 * @param agentNames Configured agent names (from `agent_servers`).
	 *                   Accepted as either a `Set` or an array for
	 *                   caller convenience.
	 * @returns `{valid, errors}`. `valid === errors.length === 0`.
	 */
	validate(
		tasks: DagTaskDefinition[],
		agentNames: ReadonlySet<string> | string[],
	): DagValidationResult {
		const agents =
			agentNames instanceof Set
				? (agentNames as ReadonlySet<string>)
				: new Set(agentNames);

		const errors: string[] = [];
		for (const check of this.checks(agents)) {
			errors.push(...check(tasks));
		}

		return { valid: errors.length === 0, errors };
	}

	/**
	 * Ordered pipeline of validation checks. Order is chosen so cheaper
	 * structural checks run before graph traversal:
	 *  1. duplicate IDs
	 *  2. reserved IDs
	 *  3. dangling references (prerequisite for meaningful cycle detection)
	 *  4. agent availability
	 *  5. cycle detection via DFS
	 */
	private checks(agents: ReadonlySet<string>): Array<(tasks: DagTaskDefinition[]) => string[]> {
		return [
			(tasks) => this.detectDuplicateIds(tasks),
			(tasks) => this.detectReservedIds(tasks),
			(tasks) => this.detectDanglingRefs(tasks),
			(tasks) => this.detectUnknownAgents(tasks, agents),
			(tasks) => this.detectCycles(tasks),
		];
	}

	/** Reject step IDs that appear more than once in the task list. */
	private detectDuplicateIds(tasks: DagTaskDefinition[]): string[] {
		const seen = new Set<string>();
		const reported = new Set<string>();
		const errors: string[] = [];
		for (const task of tasks) {
			if (seen.has(task.id) && !reported.has(task.id)) {
				errors.push(`duplicate step ID: "${task.id}"`);
				reported.add(task.id);
			}
			seen.add(task.id);
		}
		return errors;
	}

	/** Reject step IDs that collide with reserved template-variable prefixes. */
	private detectReservedIds(tasks: DagTaskDefinition[]): string[] {
		const errors: string[] = [];
		const reported = new Set<string>();
		for (const task of tasks) {
			if (RESERVED_STEP_IDS.has(task.id) && !reported.has(task.id)) {
				errors.push(`reserved step ID: "${task.id}"`);
				reported.add(task.id);
			}
		}
		return errors;
	}

	/** Reject `dependsOn` entries that point at non-existent step IDs. */
	private detectDanglingRefs(tasks: DagTaskDefinition[]): string[] {
		const ids = new Set(tasks.map((t) => t.id));
		const errors: string[] = [];
		for (const task of tasks) {
			for (const dep of task.dependsOn ?? []) {
				if (!ids.has(dep)) {
					errors.push(
						`dangling reference: task "${task.id}" depends on unknown step "${dep}"`,
					);
				}
			}
		}
		return errors;
	}

	/** Reject agents not present in the configured `agent_servers` set. */
	private detectUnknownAgents(
		tasks: DagTaskDefinition[],
		agents: ReadonlySet<string>,
	): string[] {
		const errors: string[] = [];
		const reported = new Set<string>();
		for (const task of tasks) {
			if (!agents.has(task.agent) && !reported.has(task.agent)) {
				errors.push(`unknown agent: "${task.agent}"`);
				reported.add(task.agent);
			}
		}
		return errors;
	}

	/**
	 * Detect cycles via DFS, aligned with the `AcpTaskStore.findDependencyPath()`
	 * pattern: a recursive DFS that tracks the current path and a visited set,
	 * walking dependency edges (task → `dependsOn`), mirroring how
	 * `findDependencyPath()` walks `blockedBy` edges. When the DFS reaches a
	 * node already on the active path, the cycle is reconstructed from the
	 * path slice and reported as `cycle detected: a → b → a`. Edges to unknown
	 * steps are ignored here (dangling refs are reported separately).
	 *
	 * Uses the classic path + visited-on-stack coloring: `GRAY` = on the
	 * current recursion stack (used to detect a back-edge), `BLACK` = fully
	 * explored. This is the same visited/path bookkeeping as
	 * `findDependencyPath()`, extended with on-stack marking for cycle
	 * detection.
	 */
	private detectCycles(tasks: DagTaskDefinition[]): string[] {
		const deps = new Map<string, string[]>();
		for (const task of tasks) {
			deps.set(task.id, task.dependsOn ?? []);
		}

		const WHITE = 0; // unvisited
		const GRAY = 1; // on current DFS path (stack)
		const BLACK = 2; // fully explored
		const color = new Map<string, number>();
		for (const task of tasks) color.set(task.id, WHITE);

		const errors: string[] = [];
		const path: string[] = [];

		const dfs = (id: string): boolean => {
			color.set(id, GRAY);
			path.push(id);
			for (const dep of deps.get(id) ?? []) {
				if (!color.has(dep)) continue; // dangling — handled elsewhere
				const c = color.get(dep);
				if (c === GRAY) {
					// Back-edge: dep is on the current path → reconstruct the
					// closed loop from the path slice (same path-array
					// technique used by findDependencyPath()).
					const start = path.indexOf(dep);
					const cycle = path.slice(start).join(" → ") + " → " + dep;
					errors.push(`cycle detected: ${cycle}`);
					path.pop();
					return true;
				}
				if (c === WHITE && dfs(dep)) {
					path.pop();
					return true;
				}
			}
			color.set(id, BLACK);
			path.pop();
			return false;
		};

		for (const task of tasks) {
			if (color.get(task.id) === WHITE && dfs(task.id)) {
				break; // report the first cycle deterministically
			}
		}
		return errors;
	}
}

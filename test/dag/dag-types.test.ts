import { describe, it, expect } from "vitest";
import type {
	DagTaskDefinition,
	DagStepStatus,
	DagStatus,
	DagStepRecord,
	DagRecord,
	DagOptions,
	DagIndexEntry,
} from "../../src/config/types.js";

/**
 * Task 1.1 — DAG types in src/config/types.ts.
 *
 * These are pure compile-time types, so this test serves two purposes:
 *  1. Compile-time: importing the named types fails the build if any are missing.
 *  2. Runtime: constructing each interface asserts the documented shape.
 */
describe("DAG types (task 1.1)", () => {
	it("DagTaskDefinition supports all documented fields", () => {
		const task: DagTaskDefinition = {
			id: "a",
			agent: "gemini",
			prompt: "Research X",
			dependsOn: ["b"],
			gate: "after",
		};
		expect(task.id).toBe("a");
		expect(task.agent).toBe("gemini");
		expect(task.dependsOn).toEqual(["b"]);
		expect(task.gate).toBe("after");
	});

	it("DagTaskDefinition allows optional fields to be omitted", () => {
		const task: DagTaskDefinition = { id: "a", agent: "gemini", prompt: "p" };
		expect(task.dependsOn).toBeUndefined();
		expect(task.gate).toBeUndefined();
	});

	it("DagStepStatus covers the documented lifecycle states", () => {
		const statuses: DagStepStatus[] = [
			"pending",
			"running",
			"completed",
			"failed",
			"skipped",
			"cancelled",
		];
		expect(new Set(statuses)).toEqual(
			new Set([
				"pending",
				"running",
				"completed",
				"failed",
				"skipped",
				"cancelled",
			]),
		);
	});

	it("DagStatus covers the documented DAG-level states", () => {
		const statuses: DagStatus[] = [
			"pending",
			"running",
			"completed",
			"failed",
			"cancelled",
			"stale",
		];
		expect(new Set(statuses)).toEqual(
			new Set([
				"pending",
				"running",
				"completed",
				"failed",
				"cancelled",
				"stale",
			]),
		);
	});

	it("DagStepRecord captures output / error / retry / timing", () => {
		const step: DagStepRecord = {
			id: "a",
			agent: "gemini",
			prompt: "p",
			dependsOn: [],
			gate: "needs",
			status: "completed",
			output: "result",
			error: undefined,
			startedAt: "2026-06-19T00:00:00.000Z",
			completedAt: "2026-06-19T00:00:12.000Z",
			durationMs: 12000,
			retryCount: 0,
		};
		expect(step.status).toBe("completed");
		expect(step.output).toBe("result");
		expect(step.retryCount).toBe(0);
	});

	it("DagOptions defaults conceptually map to failFast / maxRetries", () => {
		const opts: DagOptions = { failFast: true, maxRetries: 2 };
		expect(opts.failFast).toBe(true);
		expect(opts.maxRetries).toBe(2);
	});

	it("DagOptions fields are optional", () => {
		const opts: DagOptions = {};
		expect(opts.failFast).toBeUndefined();
		expect(opts.maxRetries).toBeUndefined();
	});

	it("DagRecord carries definition, steps, args, options, and lifecycle metadata", () => {
		const record: DagRecord = {
			dagId: "abc123",
			tasks: [{ id: "a", agent: "gemini", prompt: "p" }],
			args: { lang: "TypeScript" },
			options: { failFast: true, maxRetries: 0 },
			status: "running",
			steps: {
				a: {
					id: "a",
					agent: "gemini",
					prompt: "p",
					dependsOn: [],
					gate: "needs",
					status: "pending",
				},
			},
			currentWave: 1,
			totalWaves: 1,
			createdAt: "2026-06-19T00:00:00.000Z",
			updatedAt: "2026-06-19T00:00:00.000Z",
			completedAt: undefined,
		};
		expect(record.dagId).toBe("abc123");
		expect(record.status).toBe("running");
		expect(record.args).toEqual({ lang: "TypeScript" });
		expect(record.steps.a.status).toBe("pending");
		expect(record.currentWave).toBe(1);
		expect(record.totalWaves).toBe(1);
	});

	it("DagIndexEntry holds summary status info", () => {
		const entry: DagIndexEntry = {
			dagId: "abc123",
			status: "running",
			totalSteps: 3,
			completedSteps: 1,
			failedSteps: 0,
			createdAt: "2026-06-19T00:00:00.000Z",
			updatedAt: "2026-06-19T00:00:00.000Z",
			completedAt: undefined,
		};
		expect(entry.dagId).toBe("abc123");
		expect(entry.status).toBe("running");
		expect(entry.totalSteps).toBe(3);
		expect(entry.completedSteps).toBe(1);
	});
});

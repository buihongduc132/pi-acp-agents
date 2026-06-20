import { describe, it, expect } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.4: Support `{<step-id>.status}` resolution from step statuses.
 *
 * These tests assert the dedicated `{<step-id>.status}` interpolation
 * behaviour required by the `dag-execution` spec ("Template variable
 * resolution" → "Resolve step status"). The resolver MUST expand every
 * `{<step-id>.status}` reference in a step prompt to the lifecycle status
 * string of that step, using regex-based string interpolation (design.md D3).
 *
 * Step statuses follow the lifecycle defined in the `dag-execution` spec
 * state-machine requirement: `pending`, `running`, `completed`, `failed`,
 * `skipped`, `cancelled`.
 *
 * Task 4.2 provided the generic `resolve()` surface; this file provides
 * exhaustive coverage of the status-reference arm in isolation.
 */
describe("TemplateResolver — {<step-id>.status} resolution (task 4.4)", () => {
	it("resolves a completed step status (spec scenario)", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Previous step status: {a.status}",
			{},
			{ a: "completed" },
			{},
		);
		expect(out).toBe("Previous step status: completed");
	});

	it("resolves a failed step status", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Previous step status: {a.status}",
			{},
			{ a: "failed" },
			{},
		);
		expect(out).toBe("Previous step status: failed");
	});

	it("resolves a running step status", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("a is {a.status}", {}, { a: "running" }, {});
		expect(out).toBe("a is running");
	});

	it("resolves a pending step status", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("a is {a.status}", {}, { a: "pending" }, {});
		expect(out).toBe("a is pending");
	});

	it("resolves a skipped step status", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("a is {a.status}", {}, { a: "skipped" }, {});
		expect(out).toBe("a is skipped");
	});

	it("resolves a cancelled step status", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"a is {a.status}",
			{},
			{ a: "cancelled" },
			{},
		);
		expect(out).toBe("a is cancelled");
	});

	it("resolves multiple distinct step statuses in one prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"a={a.status}, b={b.status}",
			{},
			{ a: "completed", b: "failed" },
			{},
		);
		expect(out).toBe("a=completed, b=failed");
	});

	it("resolves repeated references to the same step status", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.status} and again {a.status}",
			{},
			{ a: "completed" },
			{},
		);
		expect(out).toBe("completed and again completed");
	});

	it("resolves step IDs containing underscores", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{data_fetch.status}",
			{},
			{ data_fetch: "completed" },
			{},
		);
		expect(out).toBe("completed");
	});

	it("resolves step IDs containing hyphens", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{data-fetch.status}",
			{},
			{ "data-fetch": "completed" },
			{},
		);
		expect(out).toBe("completed");
	});

	it("resolves step IDs containing digits", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{step1.status}",
			{},
			{ step1: "completed" },
			{},
		);
		expect(out).toBe("completed");
	});

	it("leaves the reference unresolved when the step has no recorded status", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("Use {missing.status}", {}, {}, {});
		expect(out).toBe("Use {missing.status}");
	});

	it("resolves to an empty string when the recorded status is empty", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("[{a.status}]", {}, { a: "" }, {});
		expect(out).toBe("[]");
	});

	it("resolves a status reference independently from the output reference", () => {
		// A step with both an output and a status: {a.output} and {a.status}
		// must resolve from their respective maps, not cross-contaminate.
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.output} ({a.status})",
			{ a: "Findings text" },
			{ a: "completed" },
			{},
		);
		expect(out).toBe("Findings text (completed)");
	});

	it("does not treat an output value as a status and vice versa", () => {
		const resolver = new TemplateResolver();
		// status map has no entry for `a`, so {a.status} stays unresolved
		const out = resolver.resolve(
			"{a.output} | {a.status}",
			{ a: "OUT" },
			{},
			{},
		);
		expect(out).toBe("OUT | {a.status}");
	});

	it("resolves a status reference at the start of the prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.status} tail",
			{},
			{ a: "completed" },
			{},
		);
		expect(out).toBe("completed tail");
	});

	it("resolves a status reference at the end of the prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"head {a.status}",
			{},
			{ a: "completed" },
			{},
		);
		expect(out).toBe("head completed");
	});
});

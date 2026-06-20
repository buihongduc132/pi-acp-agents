import { describe, it, expect } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.5: Support `{dag.args.<key>}` resolution from workflow-level
 * arguments.
 *
 * These tests assert the dedicated `{dag.args.<key>}` interpolation
 * behaviour required by the `dag-execution` spec ("Template variable
 * resolution" → "Resolve workflow-level arguments") and the `dag-submission`
 * spec ("DAG submission via single tool call" → "Submit with workflow-level
 * arguments"). The resolver MUST expand every `{dag.args.<key>}` reference
 * in a step prompt to the corresponding value from the DAG submission's
 * `args` map, using regex-based string interpolation (design.md D3).
 *
 * Task 4.2 provided the generic `resolve()` surface; this file provides
 * exhaustive coverage of the workflow-arguments arm in isolation.
 */
describe("TemplateResolver — {dag.args.<key>} resolution (task 4.5)", () => {
	it("resolves a single workflow-level argument (spec scenario)", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Write in {dag.args.lang}",
			{},
			{},
			{ lang: "TypeScript" },
		);
		expect(out).toBe("Write in TypeScript");
	});

	it("resolves the dag-submission spec scenario ({dag.args.topic})", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Research {dag.args.topic} thoroughly",
			{},
			{},
			{ topic: "authentication" },
		);
		expect(out).toBe("Research authentication thoroughly");
	});

	it("resolves multiple distinct workflow arguments in one prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{dag.args.lang} {dag.args.framework} {dag.args.version}",
			{},
			{},
			{ lang: "TypeScript", framework: "React", version: "18" },
		);
		expect(out).toBe("TypeScript React 18");
	});

	it("resolves repeated references to the same workflow argument", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{dag.args.lang} and again {dag.args.lang}",
			{},
			{},
			{ lang: "TS" },
		);
		expect(out).toBe("TS and again TS");
	});

	it("resolves argument keys containing underscores", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Use {dag.args.db_host}",
			{},
			{},
			{ db_host: "localhost" },
		);
		expect(out).toBe("Use localhost");
	});

	it("resolves argument keys containing hyphens", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Use {dag.args.db-host}",
			{},
			{},
			{ "db-host": "localhost" },
		);
		expect(out).toBe("Use localhost");
	});

	it("resolves argument keys containing digits", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Port {dag.args.port1}",
			{},
			{},
			{ port1: "8080" },
		);
		expect(out).toBe("Port 8080");
	});

	it("resolves argument keys containing dots (nested-looking keys)", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Use {dag.args.user.name}",
			{},
			{},
			{ "user.name": "alice" },
		);
		expect(out).toBe("Use alice");
	});

	it("leaves the reference unresolved when the argument is absent", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("Use {dag.args.missing}", {}, {}, {});
		expect(out).toBe("Use {dag.args.missing}");
	});

	it("resolves to an empty string when the argument value is empty", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("[{dag.args.x}]", {}, {}, { x: "" });
		expect(out).toBe("[]");
	});

	it("preserves multi-line content in the resolved argument value", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"Config:\n{dag.args.cfg}",
			{},
			{},
			{ cfg: "a=1\nb=2\nc=3" },
		);
		expect(out).toBe("Config:\na=1\nb=2\nc=3");
	});

	it("does not treat a `{<step>.output}` reference as a dag.args reference", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.output} in {dag.args.lang}",
			{ a: "plan" },
			{},
			{ lang: "TS" },
		);
		expect(out).toBe("plan in TS");
	});

	it("does not treat a `{<step>.status}` reference as a dag.args reference", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{a.status} in {dag.args.lang}",
			{},
			{ a: "completed" },
			{ lang: "TS" },
		);
		expect(out).toBe("completed in TS");
	});

	it("does not match a bare `{dag}` or `{dag.something}` reference", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("{dag} and {dag.something}", {}, {}, {
			dag: "ignored",
		});
		// Only the `{dag.args.<key>}` form is a workflow-argument reference.
		expect(out).toBe("{dag} and {dag.something}");
	});

	it("resolves a workflow-argument reference at the start of the prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("{dag.args.x} tail", {}, {}, { x: "H" });
		expect(out).toBe("H tail");
	});

	it("resolves a workflow-argument reference at the end of the prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve("head {dag.args.x}", {}, {}, { x: "T" });
		expect(out).toBe("head T");
	});

	it("resolves all workflow-argument references when many appear in one prompt", () => {
		const resolver = new TemplateResolver();
		const out = resolver.resolve(
			"{dag.args.a}{dag.args.b}{dag.args.c}",
			{},
			{},
			{ a: "1", b: "2", c: "3" },
		);
		expect(out).toBe("123");
	});
});

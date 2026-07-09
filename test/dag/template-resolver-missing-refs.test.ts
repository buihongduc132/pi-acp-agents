import { describe, it, expect, vi } from "vitest";
import { TemplateResolver } from "../../src/dag/template-resolver.js";

/**
 * Task 4.7: Implement missing reference detection — unresolved variables
 * after the resolution pass indicate a bug (log a warning).
 *
 * The `dag-execution` spec requires template resolution to expand known
 * variables; a prompt that STILL contains an unresolved `{...}` template
 * variable after resolution indicates a bug (e.g. referencing a step id
 * that has no recorded output/status, or a malformed variable). The
 * resolver SHALL detect these leftover references and emit a warning so
 * the bug is visible to operators rather than silently passing a literal
 * `{foo.output}` into a downstream agent prompt.
 */
describe("TemplateResolver — missing reference detection (task 4.7)", () => {
	it("logs a warning when an unresolved {<step>.output} reference remains", () => {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const resolver = new TemplateResolver({ logger: logger as any });
		resolver.resolve("Use {ghost.output}", {}, {}, {});
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("logs a warning when an unresolved {<step>.status} reference remains", () => {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const resolver = new TemplateResolver({ logger: logger as any });
		resolver.resolve("status: {ghost.status}", {}, {}, {});
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("logs a warning when an unresolved {dag.args.<key>} reference remains", () => {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const resolver = new TemplateResolver({ logger: logger as any });
		resolver.resolve("lang: {dag.args.missing}", {}, {}, {});
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("does NOT log a warning when all references resolve successfully", () => {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const resolver = new TemplateResolver({ logger: logger as any });
		resolver.resolve(
			"{a.output} {a.status} {dag.args.lang}",
			{ a: "out" },
			{ a: "completed" },
			{ lang: "TS" },
		);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("does NOT log a warning for a prompt with no template variables", () => {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const resolver = new TemplateResolver({ logger: logger as any });
		resolver.resolve("plain prompt with no variables", {}, {}, {});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("includes the unresolved reference text in the warning message", () => {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const resolver = new TemplateResolver({ logger: logger as any });
		resolver.resolve("Use {ghost.output} now", {}, {}, {});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const [msg] = logger.warn.mock.calls[0];
		expect(String(msg)).toContain("{ghost.output}");
	});

	it("uses the injected logger's warn method (does not throw without a logger)", () => {
		// default no-op logger path: must not throw
		const resolver = new TemplateResolver();
		expect(() => resolver.resolve("{ghost.output}", {}, {}, {})).not.toThrow();
	});
});

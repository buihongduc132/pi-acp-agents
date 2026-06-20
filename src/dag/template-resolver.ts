/**
 * TemplateResolver — variable interpolation & truncation for DAG step prompts.
 *
 * Before the executor dispatches each step, it asks this resolver to expand
 * the template variables in the step's `prompt` string. Supported variables
 * (per the `dag-execution` spec, "Template variable resolution"):
 *
 *  - `{<step-id>.output}`  → text result of a completed step (truncated if large)
 *  - `{<step-id>.status}`  → lifecycle status of a step
 *  - `{dag.args.<key>}`    → workflow-level argument from the DAG submission
 *
 * Resolution is regex-based string interpolation aligned with design.md D3.
 * Large outputs are truncated to a configurable char limit (default 8000,
 * from `dagOutputTruncateChars`) with a trailing
 * `\n\n[... output truncated, {N} chars omitted ...]` marker so downstream
 * prompts do not blow past agent context windows.
 *
 * Missing reference detection (task 4.7): any `{...}` template variable that
 * remains unresolved after the interpolation pass indicates a bug (e.g. a
 * step id with no recorded output/status, or a malformed variable). The
 * resolver scans the resolved prompt for leftover `{...}` placeholders and
 * logs a warning via the injected {@link Logger} so the bug is visible to
 * operators instead of silently passing a literal `{foo.output}` into a
 * downstream agent prompt.
 *
 * Task 4.1: create the class with its constructor.
 * Task 4.2: implement `resolve()` — regex-based string interpolation.
 * Subsequent tasks (4.3–4.7) add detailed coverage of each variable
 * type, truncation, and missing-reference warnings.
 */

/**
 * Minimal logger surface the resolver needs for missing-reference
 * warnings (task 4.7). Deliberately local and structural so callers can
 * inject any logger object (the repo's `Logger`, a vitest mock, etc.)
 * without forcing a new `warn` method onto the shared `Logger` interface
 * across every adapter.
 */
export interface ResolverLogger {
	warn(msg: string, data?: unknown): void;
}

/** Internal no-op default so the resolver is safe to build without a logger. */
const noopResolverLogger: ResolverLogger = { warn() {} };

/** Constructor options for {@link TemplateResolver}. */
export interface TemplateResolverOptions {
	/**
	 * Maximum number of characters injected for a single `{<step>.output}`
	 * reference. Outputs longer than this are truncated with a trailing
	 * omission marker. Defaults to the `dagOutputTruncateChars` config
	 * value (8000).
	 */
	truncateChars?: number;
	/**
	 * Logger used to emit warnings when an unresolved template variable is
	 * detected after the interpolation pass (task 4.7). Defaults to a
	 * no-op logger so the resolver is safe to construct without one.
	 */
	logger?: ResolverLogger;
}

/** Regex matching any leftover `{...}` template placeholder. */
/** Regex for known template patterns only — used by hasUnresolvedTemplates
 * to avoid false positives on legitimate braces in dag.args values. */
const TEMPLATE_PATTERN_RE = /\{(dag\.args\.[^}]+|[a-zA-Z0-9_-]+\.(?:output|status))\}/g;
/** Non-global version for .test() — avoids /g lastIndex statefulness. */
const TEMPLATE_PATTERN_RE_NON_GLOBAL = /\{(dag\.args\.[^}]+|[a-zA-Z0-9_-]+\.(?:output|status))\}/;

export class TemplateResolver {
	/** Configured truncation limit for injected step outputs. */
	readonly truncateChars: number;
	/** Logger for missing-reference warnings (task 4.7). */
	private readonly logger: ResolverLogger;

	constructor(options: TemplateResolverOptions = {}) {
		this.truncateChars = options.truncateChars ?? 8_000;
		this.logger = options.logger ?? noopResolverLogger;
	}

	/**
	 * Resolve template variables in `prompt` via regex-based string
	 * interpolation (design.md D3).
	 *
	 * @param prompt         raw step prompt, may contain template vars
	 * @param stepOutputs    map of step-id → text output (completed steps)
	 * @param stepStatuses   map of step-id → lifecycle status string
	 * @param dagArgs        workflow-level arguments from the DAG submission
	 * @returns the prompt with all resolvable template variables expanded
	 */
	resolve(
		prompt: string,
		stepOutputs: Record<string, string>,
		stepStatuses: Record<string, string>,
		dagArgs: Record<string, string>,
	): string {
		// Single-pass resolution prevents template injection: by resolving all
		// three variable types in one regex pass, dag.args values containing
		// `{stepId.output}` patterns are inserted as raw text and never
		// re-processed by a subsequent pass.
		const TEMPLATE_RE = /\{(dag\.args\.[^}]+|[a-zA-Z0-9_-]+\.(?:output|status))\}/g;
		const result = prompt.replace(TEMPLATE_RE, (m, expr: string) => {
			if (expr.startsWith("dag.args.")) {
				const key = expr.slice("dag.args.".length);
				const v = dagArgs[key];
				return v === undefined ? m : v;
			}
			const dotIdx = expr.lastIndexOf(".");
			const id = expr.slice(0, dotIdx);
			const type = expr.slice(dotIdx + 1);
			if (type === "output") {
				const v = stepOutputs[id];
				return v === undefined ? m : this.truncate(v);
			} else {
				const v = stepStatuses[id];
				return v === undefined ? m : v;
			}
		});

		this.warnUnresolved(result);
		return result;
	}

	/**
	 * Check whether the resolved prompt still contains unresolved template
	 * placeholders. Used by the executor to fail a step at dispatch time when
	 * a template variable could not be resolved (unknown step id, missing
	 * dag arg, or typo) — per README spec.
	 */
	hasUnresolvedTemplates(resolvedPrompt: string): boolean {
		return TEMPLATE_PATTERN_RE_NON_GLOBAL.test(resolvedPrompt);
	}

	/**
	 * Detect leftover `{...}` template placeholders in the resolved prompt
	 * and log a warning per unresolved reference (task 4.7). An unresolved
	 * variable after the interpolation pass indicates a bug — the resolved
	 * value was unavailable (unknown step id, missing dag arg, or a typo).
	 */
	private warnUnresolved(resolved: string): void {
		const matches = resolved.match(TEMPLATE_PATTERN_RE);
		if (!matches) {
			return;
		}
		for (const ref of matches) {
			this.logger.warn(
				`acp-dag: unresolved template variable ${ref} in step prompt ` +
					`(unknown step id, missing dag arg, or typo)`,
			);
		}
	}

	/**
	 * Truncate an injected step output when it exceeds the configured
	 * char limit (design.md D3 / risk R1). Outputs at or below the
	 * limit are returned unchanged; longer outputs are cut to the first
	 * `truncateChars` characters and suffixed with an omission marker
	 * so downstream prompts do not blow past agent context windows.
	 *
	 * Per the `dag-execution` spec "Truncate large outputs" scenario:
	 * a 15000-char output with a 8000-char limit becomes the first
	 * 8000 chars + `\n\n[... output truncated, 7000 chars omitted ...]`.
	 */
	private truncate(output: string): string {
		if (output.length <= this.truncateChars) {
			return output;
		}
		const omitted = output.length - this.truncateChars;
		return (
			output.slice(0, this.truncateChars) +
			`\n\n[... output truncated, ${omitted} chars omitted ...]`
		);
	}
}

/**
 * Persona / system-prompt resolver for per-alias persona injection.
 *
 * Resolution is by **content shape** (single string field, no variant type):
 * - contains whitespace → `inline` (the string itself is the persona)
 * - starts with `http`  → `gist` — **DEFERRED** (soft-fail; NO network call).
 *   Private gists need a token + cache story; tracked in
 *   `flow/plans/acp-persona-system-prompt.md`. Not implemented in v1.
 * - otherwise (bare token/path) → `file` (`readFileSync`)
 *
 * Soft-fail contract: resolution NEVER throws. On failure (missing file,
 * unreadable, deferred gist) it returns `{ warning }` with no `text`. The
 * caller surfaces the warning as a callout; the session runs with no persona.
 *
 * NOTE (honest limitation): ACP has no native system-prompt channel (verified
 * against @agentclientprotocol/sdk@0.21.1 zod schemas: InitializeRequest /
 * NewSessionRequest / PromptRequest carry no systemPrompt; Role enum is
 * assistant|user only). The resolved persona is prepended to the first user
 * message of a fresh session — practical high priority, not protocol-level.
 */
import { readFileSync } from "node:fs";

/** Resolution outcome. Exactly one of `text` / `warning` is meaningful per call. */
export interface PersonaResolution {
	/** How the persona was resolved. */
	kind: "inline" | "file" | "gist" | "none";
	/** The resolved persona text, when resolution succeeded. Undefined on failure/none. */
	text?: string;
	/** Soft-fail warning (missing file, deferred gist, etc.). Undefined on success. */
	warning?: string;
}

/**
 * Resolve a persona/systemPrompt value by content shape. Never throws.
 *
 * @param systemPrompt raw config value (inline text, file path, or gist URL).
 *   `undefined`/empty → no persona ({ kind: "none" }).
 */
export function resolvePersona(systemPrompt: string | undefined): PersonaResolution {
	if (!systemPrompt || systemPrompt.trim() === "") {
		return { kind: "none" };
	}

	// Gist: http(s)-prefixed. DEFERRED — do NOT fetch (private gists need token
	// + cache; see plan). Soft-fail with a callout.
	if (/^https?:\/\//i.test(systemPrompt)) {
		return {
			kind: "gist",
			warning: `[persona] gist source not yet supported — deferred (see flow/plans/acp-persona-system-prompt.md). value: ${systemPrompt.slice(0, 60)}`,
		};
	}

	// Inline: contains whitespace → the string IS the persona.
	if (/\s/.test(systemPrompt)) {
		return { kind: "inline", text: systemPrompt };
	}

	// File: bare path (no whitespace). readFileSync, soft-fail on error.
	try {
		const text = readFileSync(systemPrompt, "utf-8");
		return { kind: "file", text };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return {
			kind: "file",
			warning: `[persona] systemPrompt file '${systemPrompt}' not found or unreadable — skipped (no persona applied). ${reason.slice(0, 80)}`,
		};
	}
}

/**
 * RED PHASE (TDD) — Finding P2: Output pollution (boot banner in result.text)
 *
 * This file is intentionally RED. It imports `stripAgentBootBanner` from
 * `../../src/core/output-cleaner.js`, a module that does NOT exist yet. The
 * import will fail at collection time, proving the cleaning capability is
 * MISSING — which is exactly what Finding P2 is about.
 *
 * The intended fix (GREEN phase, not this task) will create
 * `src/core/output-cleaner.ts` exporting `stripAgentBootBanner()`.
 *
 * Why RED: real agents (pi) emit a boot banner before the real answer:
 *   pi v0.79.3
 *   ---
 *   ## Context
 *   ## Skills
 *   ## Prompts
 *   ## Extensions
 *   hindsight: ... recall ...
 *   MCP: 1 servers connected (63 tools)   <-- last banner marker
 *   <real answer here>
 *
 * `AcpClient.prompt()` (src/core/client.ts:614) returns
 * `{ text: this.collectedText }`, and collectedText (line 727) accumulates
 * EVERY chunk including the boot banner. So result.text is polluted, and that
 * pollution flows into DAG step.output, fanout, async-executor, acp_spawn.
 *
 * These tests define the contract the cleaner must satisfy. When the module
 * appears in GREEN, all four tests should pass with no further edits.
 */
import { describe, it, expect } from "vitest";
import { stripAgentBootBanner } from "../../src/core/output-cleaner.js";

/**
 * A realistic polluted payload simulating a real `pi` agent boot banner
 * immediately followed by the genuine answer. The trailing `hello world 1` is
 * the only content that should survive cleaning.
 */
const POLLUTED_BANNER =
	"pi v0.79.3\n" +
	"---\n" +
	"\n" +
	"## Context\n" +
	"loaded\n" +
	"## Skills\n" +
	"140 Skills\n" +
	"## Prompts\n" +
	"90 Prompts\n" +
	"## Extensions\n" +
	"30 Extensions\n" +
	"hindsight: [x] recall (sync): fail (3.7s)\n" +
	"MCP: 1 servers connected (63 tools)hello world 1";

describe("stripAgentBootBanner — RED (capability missing)", () => {
	it("strips the pi boot banner and returns only the real answer", () => {
		// The clean tail is exactly the genuine answer.
		const cleaned = stripAgentBootBanner(POLLUTED_BANNER);
		expect(cleaned).toBe("hello world 1");
	});

	it("returns text as-is when no boot-banner markers are present", () => {
		const plain = "Just a normal answer with no banner at all.";
		const cleaned = stripAgentBootBanner(plain);
		expect(cleaned).toBe(plain);
	});

	it("falls back to the original when stripping would yield empty text", () => {
		// A banner with NO trailing answer — cleaner must NOT return "".
		const bannerOnly =
			"pi v0.79.3\n---\n## Context\nloaded\n## Skills\n140 Skills\n" +
			"## Prompts\n90 Prompts\n## Extensions\n30 Extensions\n" +
			"hindsight: [x] recall (sync): fail (3.7s)\n" +
			"MCP: 1 servers connected (63 tools)";
		const cleaned = stripAgentBootBanner(bannerOnly);
		// Must not collapse to empty string — return original as fallback.
		expect(cleaned).toBe(bannerOnly);
		expect(cleaned.length).toBeGreaterThan(0);
	});

	it("does NOT strip marker-looking lines that appear mid-response", () => {
		// If a marker-like line appears AFTER legitimate content, it is part of
		// the answer, not a boot banner. The cleaner must leave it intact.
		const legitWithMarker =
			"Here is my analysis.\n\n" +
			"## Skills needed for this task\n" +
			"MCP: not relevant here\n";
		const cleaned = stripAgentBootBanner(legitWithMarker);
		expect(cleaned).toBe(legitWithMarker);
	});
});

/**
 * RED PHASE (TDD) — Finding P2: Output pollution flows into DAG step.output
 *
 * Proves the pollution end-to-end: when a real agent (pi) returns a boot
 * banner + answer, `coordinator.delegate()` hands back the polluted string,
 * and the DAG executor stores it verbatim as `step.output`. Downstream
 * consumers (fanout, template resolution, acp_spawn one-shot) then read the
 * polluted value.
 *
 * Pattern follows test/dag/dag-executor-execute.test.ts (makeMockCoordinator /
 * makeSetup / makeDagDefinition). The mock coordinator returns a POLLUTED
 * string identical in shape to what a real `pi` boot emits.
 *
 * Assertions below are expected to FAIL while the output-cleaner is absent:
 *   - step.output === "hello world 1"            (actually full banner)
 *   - step.output does NOT contain "## Skills"    (it does)
 *   - step.output does NOT contain "MCP: 1 servers connected" (it does)
 *
 * GREEN will wire stripAgentBootBanner() into the result path so these hold.
 */
import { describe, it, expect, vi } from "vitest";
import { DagExecutor } from "../../src/dag/dag-executor.js";
import { DagStore } from "../../src/dag/dag-store.js";
import { TemplateResolver } from "../../src/dag/template-resolver.js";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { createNoopLogger } from "../../src/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import type { DagTaskDefinition } from "../../src/config/types.js";

/** Polluted string simulating a real `pi` agent boot banner + real answer. */
const POLLUTED =
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

/** The genuine answer that should be the only thing stored as step.output. */
const CLEAN_ANSWER = "hello world 1";

/** Mock coordinator that returns the polluted text exactly as a real agent would. */
function makePollutedCoordinator(): {
	instance: AgentCoordinator;
	delegateSpy: ReturnType<typeof vi.fn>;
} {
	const delegateSpy = vi.fn(async () => {
		return { text: POLLUTED, stopReason: "end_turn", sessionId: "sess-pi" };
	});
	const instance = { delegate: delegateSpy } as unknown as AgentCoordinator;
	return { instance, delegateSpy };
}

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-red-pollution-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	return { store, resolver, circuitBreaker, logger, dagDir };
}

function makeDagDefinition(
	tasks: Array<{ id: string; agent: string; prompt: string; dependsOn?: string[] }>,
): { tasks: DagTaskDefinition[] } {
	return { tasks };
}

describe("DAG output pollution — RED (P2: boot banner leaks into step.output)", () => {
	it("stores the CLEAN answer, not the boot banner", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator, delegateSpy } = makePollutedCoordinator();

		const executor = new DagExecutor({
			store,
			resolver,
			coordinator,
			circuitBreaker,
			logger,
		});

		const record = store.create(
			makeDagDefinition([{ id: "a", agent: "pi", prompt: "Say hello" }]),
		);

		await executor.execute(record.dagId);

		// The delegate WAS called with the polluted text available.
		expect(delegateSpy).toHaveBeenCalledTimes(1);

		const final = store.get(record.dagId)!;
		expect(final.steps["a"].status).toBe("completed");

		// === RED assertions (expected to FAIL until output-cleaner is wired) ===
		// (1) step.output must be the clean answer, not the whole polluted blob.
		expect(final.steps["a"].output).toBe(CLEAN_ANSWER);
	});

	it("does NOT leak the ## Skills banner line into step.output", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makePollutedCoordinator();

		const executor = new DagExecutor({
			store,
			resolver,
			coordinator,
			circuitBreaker,
			logger,
		});

		const record = store.create(
			makeDagDefinition([{ id: "a", agent: "pi", prompt: "Say hello" }]),
		);

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		// RED: this currently contains the banner line.
		expect(final.steps["a"].output).not.toContain("## Skills");
	});

	it("does NOT leak the 'MCP: 1 servers connected' banner line into step.output", async () => {
		const { store, resolver, circuitBreaker, logger } = makeSetup();
		const { instance: coordinator } = makePollutedCoordinator();

		const executor = new DagExecutor({
			store,
			resolver,
			coordinator,
			circuitBreaker,
			logger,
		});

		const record = store.create(
			makeDagDefinition([{ id: "a", agent: "pi", prompt: "Say hello" }]),
		);

		await executor.execute(record.dagId);

		const final = store.get(record.dagId)!;
		// RED: this currently contains the MCP banner line.
		expect(final.steps["a"].output).not.toContain("MCP: 1 servers connected");
	});
});

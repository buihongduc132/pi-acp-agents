import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DagExecutor } from "../../src/dag/dag-executor.js";
import { DagStore } from "../../src/dag/dag-store.js";
import { TemplateResolver } from "../../src/dag/template-resolver.js";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import { AcpCircuitBreaker } from "../../src/core/circuit-breaker.js";
import { createNoopLogger } from "../../src/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import type { DagTaskDefinition } from "../../src/config/types.js";

/**
 * Task 5.11: Implement stale DAG detection — mark `running` DAGs with no
 * transitions for `dagStaleTimeoutMs` as `stale`; exclude from auto-resume
 * in `findRunning()`.
 *
 * Specs/dag-resume scenarios:
 *  - "Mark a DAG as stale after timeout": WHEN a DAG has been in `running`
 *    state with no step transitions for 1 hour (and pi has not restarted)
 *    THEN the system SHALL mark the DAG as `stale` and log a warning event.
 *  - "Stale DAG does not auto-resume": WHEN pi restarts and finds a DAG in
 *    `stale` state THEN the system SHALL NOT resume the DAG — it SHALL
 *    leave it in `stale` state and report it in `acp_dag_status` listing.
 */

const DEFAULT_TIMEOUT = 3_600_000; // 1 hour

function makeSetup() {
	const dagDir = mkdtempSync(join(tmpdir(), "dag-stale-"));
	const store = new DagStore({
		dagDir,
		dagIndexFile: join(dagDir, "dag-index.json"),
	});
	const resolver = new TemplateResolver();
	const circuitBreaker = new AcpCircuitBreaker();
	const logger = createNoopLogger();
	const delegateSpy = vi.fn(
		async (_agent: string, message: string) => ({
			text: `out-${message}`,
			stopReason: "end_turn" as const,
			sessionId: "s",
		}),
	);
	const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
	const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });
	return { store, resolver, circuitBreaker, logger, executor, delegateSpy, dagDir };
}

const LINEAR_TASKS: DagTaskDefinition[] = [
	{ id: "a", agent: "gemini", prompt: "Research X" },
	{ id: "b", agent: "codex", prompt: "Code", dependsOn: ["a"] },
];

describe("DagExecutor.markStale (task 5.11)", () => {
	it("exposes a markStale method on DagExecutor", () => {
		const { executor } = makeSetup();
		expect(typeof executor.markStale).toBe("function");
	});

	it("marks a running DAG as stale when no transitions occurred within the timeout", () => {
		const { store, executor } = makeSetup();

		const record = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(record.dagId, "running");

		// Backdate the updatedAt to simulate 2 hours of inactivity.
		const staleTime = new Date(Date.now() - 2 * DEFAULT_TIMEOUT).toISOString();
		backdateDagRecord(store, record.dagId, staleTime);

		const staleIds = executor.markStale(DEFAULT_TIMEOUT);

		expect(staleIds).toContain(record.dagId);
		const updated = store.get(record.dagId)!;
		expect(updated.status).toBe("stale");
	});

	it("does NOT mark a running DAG as stale when transitions are recent", () => {
		const { store, executor } = makeSetup();

		const record = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(record.dagId, "running");

		// updatedAt is NOW (from the status transition). No staleness.
		const staleIds = executor.markStale(DEFAULT_TIMEOUT);

		expect(staleIds).toEqual([]);
		expect(store.get(record.dagId)!.status).toBe("running");
	});

	it("returns the list of DAG IDs marked as stale", () => {
		const { store, executor } = makeSetup();

		const r1 = store.create({ tasks: LINEAR_TASKS });
		const r2 = store.create({ tasks: LINEAR_TASKS });
		const r3 = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(r1.dagId, "running");
		store.updateDagStatus(r2.dagId, "running");
		store.updateDagStatus(r3.dagId, "running");

		// Make r1 and r3 stale, r2 fresh.
		const staleTime = new Date(Date.now() - 2 * DEFAULT_TIMEOUT).toISOString();
		backdateDagRecord(store, r1.dagId, staleTime);
		backdateDagRecord(store, r3.dagId, staleTime);

		const staleIds = executor.markStale(DEFAULT_TIMEOUT);

		expect(staleIds).toHaveLength(2);
		expect(staleIds).toContain(r1.dagId);
		expect(staleIds).toContain(r3.dagId);
		expect(staleIds).not.toContain(r2.dagId);
	});

	it("does NOT affect DAGs already in terminal states (completed/failed/cancelled)", () => {
		const { store, executor } = makeSetup();

		const completed = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(completed.dagId, "completed");

		const failed = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(failed.dagId, "failed");

		// Backdate these — they should still NOT be marked stale.
		const staleTime = new Date(Date.now() - 2 * DEFAULT_TIMEOUT).toISOString();
		backdateDagRecord(store, completed.dagId, staleTime);
		backdateDagRecord(store, failed.dagId, staleTime);

		const staleIds = executor.markStale(DEFAULT_TIMEOUT);
		expect(staleIds).toEqual([]);
		expect(store.get(completed.dagId)!.status).toBe("completed");
		expect(store.get(failed.dagId)!.status).toBe("failed");
	});

	it("does NOT affect DAGs already marked stale (idempotent)", () => {
		const { store, executor } = makeSetup();

		const record = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(record.dagId, "running");
		const staleTime = new Date(Date.now() - 2 * DEFAULT_TIMEOUT).toISOString();
		backdateDagRecord(store, record.dagId, staleTime);

		// First call marks it stale.
		executor.markStale(DEFAULT_TIMEOUT);
		expect(store.get(record.dagId)!.status).toBe("stale");

		// Second call does NOT re-mark it — it's already stale.
		const staleIds = executor.markStale(DEFAULT_TIMEOUT);
		expect(staleIds).toEqual([]);
	});

	it("returns an empty list when no DAGs exist", () => {
		const { executor } = makeSetup();
		const staleIds = executor.markStale(DEFAULT_TIMEOUT);
		expect(staleIds).toEqual([]);
	});

	it("persists the stale status to disk (updatedAt is bumped)", () => {
		const { store, executor, dagDir } = makeSetup();

		const record = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(record.dagId, "running");
		const staleTime = new Date(Date.now() - 2 * DEFAULT_TIMEOUT).toISOString();
		backdateDagRecord(store, record.dagId, staleTime);

		executor.markStale(DEFAULT_TIMEOUT);

		// Verify persisted to disk.
		const persisted = JSON.parse(
			readFileSync(join(dagDir, `${record.dagId}.json`), "utf-8"),
		);
		expect(persisted.status).toBe("stale");
		// updatedAt should be bumped to now (not the old stale time).
		const updatedAt = new Date(persisted.updatedAt).getTime();
		expect(updatedAt).toBeGreaterThan(Date.now() - 10_000); // within 10s of now
	});

	it("uses the index to reflect the stale status", () => {
		const { store, executor } = makeSetup();

		const record = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(record.dagId, "running");
		const staleTime = new Date(Date.now() - 2 * DEFAULT_TIMEOUT).toISOString();
		backdateDagRecord(store, record.dagId, staleTime);

		executor.markStale(DEFAULT_TIMEOUT);

		const index = store.listAll();
		const entry = index.find((e) => e.dagId === record.dagId);
		expect(entry).toBeDefined();
		expect(entry!.status).toBe("stale");
	});
});

describe("DagStore#findRunning excludes stale DAGs (task 5.11)", () => {
	it("does NOT return DAGs in stale state (stale DAGs must not auto-resume)", () => {
		const dagDir = mkdtempSync(join(tmpdir(), "dag-stale-findrunning-"));
		const store = new DagStore({
			dagDir,
			dagIndexFile: join(dagDir, "dag-index.json"),
		});

		const running = store.create({ tasks: LINEAR_TASKS });
		const stale = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(running.dagId, "running");
		store.updateDagStatus(stale.dagId, "stale");

		const found = store.findRunning();
		expect(found).toHaveLength(1);
		expect(found[0]!.dagId).toBe(running.dagId);

		rmSync(dagDir, { recursive: true, force: true });
	});
});

describe("DagExecutor.resumeAll excludes stale DAGs (task 5.11)", () => {
	it("does NOT resume DAGs that were marked stale before resumeAll runs", async () => {
		const { store, resolver, circuitBreaker, logger, dagDir } = makeSetup();
		const dispatched: string[] = [];
		const delegateSpy = vi.fn(async (_agent: string, message: string) => {
			dispatched.push(message);
			return { text: "ok", stopReason: "end_turn" as const, sessionId: "s" };
		});
		const coordinator = { delegate: delegateSpy } as unknown as AgentCoordinator;
		const executor = new DagExecutor({ store, resolver, coordinator, circuitBreaker, logger });

		// Create a running DAG and make it stale.
		const record = store.create({ tasks: LINEAR_TASKS });
		store.updateDagStatus(record.dagId, "running");
		const staleTime = new Date(Date.now() - 2 * DEFAULT_TIMEOUT).toISOString();
		backdateDagRecord(store, record.dagId, staleTime);

		// Mark stale BEFORE resumeAll.
		executor.markStale(DEFAULT_TIMEOUT);
		expect(store.get(record.dagId)!.status).toBe("stale");

		// resumeAll should NOT resume the stale DAG.
		const resumed = await executor.resumeAll();
		expect(resumed).not.toContain(record.dagId);
		expect(delegateSpy).not.toHaveBeenCalled();
	});
});

/**
 * Helper: directly overwrite the `updatedAt` field in the persisted DAG
 * record to simulate an old timestamp (no step transitions for a long time).
 */
function backdateDagRecord(store: DagStore, dagId: string, isoDate: string): void {
	const record = store.get(dagId)!;
	record.updatedAt = isoDate;
	// Write back directly to disk.
	const { writeFileSync: wfs } = require("node:fs") as typeof import("node:fs");
	const { join: jn } = require("node:path") as typeof import("node:path");
	wfs(jn(store.dagDir, `${dagId}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");
}

/**
 * DagStore — File-backed DAG state persistence.
 *
 * One JSON file per DAG lives under `~/.pi/acp-agents/dag/<dagId>.json`,
 * plus a `dag-index.json` tracking summary status for all DAGs.
 *
 * This module is the persistence layer for the `acp-dag-delegation` change
 * (design.md D1, D7). It is intentionally kept separate from `AcpTaskStore`
 * (which manages manually-created tasks) so that wave-based, auto-managed
 * DAG step state does not pollute the manual task namespace.
 *
 * Task 2.1 scope: create the class with a constructor that ensures the
 * DAG directory exists via `safeMkdir`. The full persistence API
 * (create / get / updateStep / updateDagStatus / listAll / findRunning)
 * is implemented in subsequent tasks 2.1a–2.7.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Validate that a dagId is safe for use in file paths — prevents path
 * traversal attacks via crafted dagId values like `../../etc/passwd`.
 * Allows any alphanumeric + hyphen/underscore string but rejects path
 * separators, dots, and null bytes.
 */
const SAFE_DAG_ID_RE = /^[a-zA-Z0-9_-]+$/;
function assertValidDagId(dagId: string): void {
	if (!SAFE_DAG_ID_RE.test(dagId)) {
		throw new Error(`Invalid dagId format: "${dagId}" — must be alphanumeric/hyphen/underscore only`);
	}
}
import { safeMkdir } from "../management/safe-mkdir.js";
import type {
	DagIndexEntry,
	DagRecord,
	DagStatus,
	DagStepRecord,
	DagTaskDefinition,
} from "../config/types.js";

/** Constructor options for {@link DagStore}. */
export interface DagStoreOptions {
	/** Directory holding `<dagId>.json` files + `dag-index.json`. */
	dagDir: string;
	/** Absolute path to the `dag-index.json` summary file. */
	dagIndexFile: string;
}

export class DagStore {
	/** Directory holding `<dagId>.json` files + `dag-index.json`. */
	readonly dagDir: string;
	/** Absolute path to the `dag-index.json` summary file. */
	readonly dagIndexFile: string;

	constructor(options: DagStoreOptions) {
		this.dagDir = options.dagDir;
		this.dagIndexFile = options.dagIndexFile;
		// Per task 2.1: ensure the DAG directory exists at construction time.
		this.ensureDagDir();
	}

	/**
	 * Ensure the DAG directory exists. Idempotent: creates the directory
	 * (and any missing parents) if absent, no-op if it already exists.
	 *
	 * Task 2.1a: exposed publicly so other DagStore operations and the
	 * executor's resume path can guarantee the directory exists before
	 * touching DAG files.
	 */
	ensureDagDir(): void {
		if (!existsSync(this.dagDir)) {
			safeMkdir(this.dagDir);
		}
	}

	/**
	 * Create a new DAG record from a submission definition.
	 *
	 * Task 2.2: generates a `dagId`, initializes every task as a `pending`
	 * step, persists the record to `<dagDir>/<dagId>.json`, and appends a
	 * summary entry to `dag-index.json`. Returns the persisted record.
	 */
	create(definition: {
		tasks: DagTaskDefinition[];
		args?: Record<string, string>;
		options?: DagRecord["options"];
	}): DagRecord {
		this.ensureDagDir();

		const now = new Date().toISOString();
		const dagId = randomUUID();

		const steps: Record<string, DagStepRecord> = {};
		for (const task of definition.tasks) {
			steps[task.id] = {
				id: task.id,
				agent: task.agent,
				prompt: task.prompt,
				dependsOn: task.dependsOn ?? [],
				gate: task.gate ?? "needs",
				status: "pending",
				output: null,
				retryCount: 0,
			};
		}

		const record: DagRecord = {
			dagId,
			tasks: definition.tasks,
			args: definition.args,
			options: definition.options,
			status: "pending",
			steps,
			currentWave: 0,
			totalWaves: 0,
			createdAt: now,
			updatedAt: now,
		};

		writeFileSync(
			join(this.dagDir, `${dagId}.json`),
			JSON.stringify(record, null, 2) + "\n",
			"utf-8",
		);

		const entry: DagIndexEntry = {
			dagId,
			status: "pending",
			totalSteps: definition.tasks.length,
			completedSteps: 0,
			failedSteps: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.appendToIndex(entry);

		return record;
	}

	/**
	 * Read and return the {@link DagRecord} for the given `dagId`.
	 *
	 * Task 2.3: reads `<dagDir>/<dagId>.json` from disk and returns the
	 * parsed record. Returns `null` when the file does not exist or is
	 * unreadable (corrupt JSON), so callers can treat a missing DAG as a
	 * null result rather than a thrown error.
	 */
	get(dagId: string): DagRecord | null {
		assertValidDagId(dagId);
		const file = join(this.dagDir, `${dagId}.json`);
		if (!existsSync(file)) return null;
		try {
			return JSON.parse(readFileSync(file, "utf-8")) as DagRecord;
		} catch {
			return null;
		}
	}

	/**
	 * Apply a state transition to a single step and persist the change.
	 *
	 * Task 2.4: reads the DAG record, invokes `mutate` with a deep copy of
	 * the current step, writes the resulting step (and bumped `updatedAt`)
	 * back to `<dagId>.json`, and reconciles `dag-index.json` counters
	 * (`completedSteps` / `failedSteps`) against the previous vs. new status.
	 *
	 * Returns the mutated step on success, or `null` when the DAG or step
	 * does not exist (no disk change in that case).
	 */
	updateStep(
		dagId: string,
		stepId: string,
		mutate: (step: DagStepRecord) => DagStepRecord,
	): DagStepRecord | null {
		const record = this.get(dagId);
		if (!record) return null;
		const existing = record.steps[stepId];
		if (!existing) return null;

		// Hand the mutate callback a deep copy so external mutation of the
		// snapshot cannot corrupt persisted state.
		const previousStatus = existing.status;
		const next = mutate(JSON.parse(JSON.stringify(existing)) as DagStepRecord);

		record.steps[stepId] = next;
		record.updatedAt = new Date().toISOString();

		writeFileSync(
			join(this.dagDir, `${dagId}.json`),
			JSON.stringify(record, null, 2) + "\n",
			"utf-8",
		);

		this.reconcileIndexStepTransition(dagId, previousStatus, next.status, record.updatedAt);
		return next;
	}

	/**
	 * Transition the DAG-level status and persist the change.
	 *
	 * Task 2.5: writes the new `status` + bumped `updatedAt` to
	 * `<dagId>.json`, reflects the transition in `dag-index.json` (status +
	 * `updatedAt`), and stamps `completedAt` on both stores when the new
	 * status is terminal (`completed` / `failed` / `cancelled`). Returns
	 * the updated record, or `null` when the DAG does not exist.
	 */
	updateDagStatus(dagId: string, status: DagStatus): DagRecord | null {
		const record = this.get(dagId);
		if (!record) return null;

		const now = new Date().toISOString();
		record.status = status;
		record.updatedAt = now;
		if (isTerminalDagStatus(status) && !record.completedAt) {
			record.completedAt = now;
		}

		writeFileSync(
			join(this.dagDir, `${dagId}.json`),
			JSON.stringify(record, null, 2) + "\n",
			"utf-8",
		);

		this.reflectIndexDagStatus(dagId, status, now);
		return record;
	}

	/**
	 * Reflect a DAG-level status transition in `dag-index.json`.
	 */
	private reflectIndexDagStatus(
		dagId: string,
		status: DagStatus,
		updatedAt: string,
	): void {
		const index = this.readIndex();
		const entry = index.find((e) => e.dagId === dagId);
		if (!entry) return;
		entry.status = status;
		entry.updatedAt = updatedAt;
		if (isTerminalDagStatus(status) && !entry.completedAt) {
			entry.completedAt = updatedAt;
		}
		writeFileSync(
			this.dagIndexFile,
			JSON.stringify(index, null, 2) + "\n",
			"utf-8",
		);
	}

	/**
	 * Reconcile a single step's status transition against the matching
	 * `dag-index.json` entry. Adjusts `completedSteps` / `failedSteps`
	 * (incrementing on entry to a tracked terminal state, decrementing on
	 * exit) and bumps `updatedAt`.
	 */
	private reconcileIndexStepTransition(
		dagId: string,
		previousStatus: DagStepRecord["status"],
		nextStatus: DagStepRecord["status"],
		updatedAt: string,
	): void {
		if (previousStatus === nextStatus) {
			// Only refresh the timestamp on a no-op status transition.
			this.touchIndexEntry(dagId, updatedAt);
			return;
		}
		const index = this.readIndex();
		const entry = index.find((e) => e.dagId === dagId);
		if (!entry) return;
		if (previousStatus === "completed") entry.completedSteps -= 1;
		if (previousStatus === "failed") entry.failedSteps -= 1;
		if (nextStatus === "completed") entry.completedSteps += 1;
		if (nextStatus === "failed") entry.failedSteps += 1;
		entry.updatedAt = updatedAt;
		writeFileSync(
			this.dagIndexFile,
			JSON.stringify(index, null, 2) + "\n",
			"utf-8",
		);
	}

	/**
	 * Bump the `updatedAt` timestamp on a single index entry without
	 * touching counters.
	 */
	private touchIndexEntry(dagId: string, updatedAt: string): void {
		const index = this.readIndex();
		const entry = index.find((e) => e.dagId === dagId);
		if (!entry) return;
		entry.updatedAt = updatedAt;
		writeFileSync(
			this.dagIndexFile,
			JSON.stringify(index, null, 2) + "\n",
			"utf-8",
		);
	}

	/**
	 * Return a summary list of every DAG tracked in `dag-index.json`.
	 *
	 * Task 2.6: pure read over `dag-index.json`. Returns the entries as
	 * persisted (in submission order). Returns an empty array when the
	 * index file does not yet exist (no DAGs submitted) or is unreadable
	 * (missing/corrupt), so callers can branch on length without try/catch.
	 * This method MUST NOT mutate the index file.
	 */
	listAll(): DagIndexEntry[] {
		return this.readIndex();
	}

	/**
	 * Scan the DAG directory on disk and return every persisted DAG whose
	 * top-level status is `running`.
	 *
	 * Task 2.7: this is the resume-on-restart entry point. It MUST be a pure
	 * disk scan over the per-DAG `<dagId>.json` files — there is no in-memory
	 * state to consult after a fresh process start. It returns the full
	 * {@link DagRecord} (not just an ID) so the executor can resume from the
	 * persisted step states.
	 *
	 * `stale` DAGs are naturally excluded because `stale` is a distinct
	 * status value from `running`; the spec requires stale DAGs to NOT
	 * auto-resume. The `dag-index.json` summary file and any malformed or
	 * non-DagRecord JSON files are skipped without throwing so a single bad
	 * file cannot prevent resume of the others.
	 */
	findRunning(): DagRecord[] {
		if (!existsSync(this.dagDir)) return [];
		const running: DagRecord[] = [];
		for (const entry of readdirSync(this.dagDir)) {
			// Only per-DAG record files are candidates. The index file and any
			// non-JSON files are skipped.
			if (!entry.endsWith(".json")) continue;
			if (entry === "dag-index.json") continue;

			const file = join(this.dagDir, entry);
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(file, "utf-8"));
			} catch {
				// Malformed JSON — skip rather than crash the whole resume scan.
				continue;
			}
			if (!isDagRecord(parsed)) continue;
			if (parsed.status === "running") {
				running.push(parsed);
			}
		}
		return running;
	}

	/**
	 * Read the current index, returning an empty list when the file does
	 * not yet exist (no DAGs submitted).
	 */
	private readIndex(): DagIndexEntry[] {
		if (!existsSync(this.dagIndexFile)) return [];
		try {
			return JSON.parse(readFileSync(this.dagIndexFile, "utf-8")) as DagIndexEntry[];
		} catch {
			return [];
		}
	}

	/**
	 * Atomically rewrite `dag-index.json` with the appended entry.
	 */
	private appendToIndex(entry: DagIndexEntry): void {
		const index = this.readIndex();
		index.push(entry);
		writeFileSync(
			this.dagIndexFile,
			JSON.stringify(index, null, 2) + "\n",
			"utf-8",
		);
	}
}

/**
 * Whether a DAG-level status marks the DAG as terminal (no further
 * transitions expected). `stale` is intentionally excluded — a stale DAG
 * can be manually re-submitted, but the state itself is not a terminal
 * completion stamp.
 */
function isTerminalDagStatus(status: DagStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Runtime type guard used by {@link DagStore.findRunning} to safely narrow
 * an unknown `JSON.parse` result to a {@link DagRecord}. A per-DAG file that
 * fails this check (e.g. a stray config dump) is skipped during the resume
 * scan instead of crashing it.
 */
function isDagRecord(value: unknown): value is DagRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.dagId === "string" &&
		Array.isArray(r.tasks) &&
		typeof r.status === "string" &&
		typeof r.steps === "object" &&
		r.steps !== null
	);
}

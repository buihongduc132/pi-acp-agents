/**
 * DagExecutor — Wave-based parallel execution of DAG steps.
 *
 * This is the orchestration core of the `acp-dag-delegation` change
 * (design.md D2). It owns the topological-sort → wave loop: for each wave,
 * every step whose dependencies are satisfied is dispatched in parallel via
 * the existing {@link AgentCoordinator.delegate()} method (the executor
 * manages the wave loop directly — it does NOT hand dispatch off to
 * `AsyncExecutor`, per task 5.3). Outputs and errors are captured per step
 * and persisted through {@link DagStore} so the run survives pi restart.
 *
 * The executor is wired (design.md "Integration with existing
 * infrastructure"; task 7.1) with the existing infrastructure singletons
 * from `index.ts`:
 *
 *  - {@link AgentCoordinator} — one short-lived `delegate()` call per step
 *  - {@link AcpCircuitBreaker} — consulted before every dispatch; an open
 *    circuit fails the step immediately with
 *    `Agent "<name>" is unavailable (circuit breaker open)` (task 5.7)
 *  - {@link TemplateResolver} — expands `{<step>.output}` / `{<step>.status}`
 *    / `{dag.args.*}` in each step's prompt before dispatch (task 5.3)
 *  - {@link DagStore} — the persistence layer for DAG + step state
 *
 * Task 5.1 scope: create the class with a constructor that wires up these
 * dependencies. The execution surface — `topologicalSort()`, `execute()`,
 * wave dispatch, gate evaluation, failFast, circuit-breaker check,
 * completion detection, `cancel()`, resume, stale detection, and retry — is
 * implemented by the subsequent tasks 5.2–5.13.
 */

import type { DagStore } from "./dag-store.js";
import type {
	DagRecord,
	DagStatus,
	DagStepRecord,
	DagStepStatus,
	DagTaskDefinition,
} from "../config/types.js";
import type { TemplateResolver } from "./template-resolver.js";
import type { AgentCoordinator } from "../coordination/coordinator.js";
import type { AcpCircuitBreaker } from "../core/circuit-breaker.js";
import type { Logger } from "../logger.js";
import { createNoopLogger } from "../logger.js";

/** Constructor options for {@link DagExecutor}. */
export interface DagExecutorOptions {
	/** File-backed DAG + step state persistence. */
	store: DagStore;
	/** Template variable interpolation for step prompts. */
	resolver: TemplateResolver;
	/** Existing agent coordinator used for per-step `delegate()` dispatch. */
	coordinator: AgentCoordinator;
	/** Existing per-agent circuit breaker consulted before each dispatch. */
	circuitBreaker: AcpCircuitBreaker;
	/**
	 * Optional existing async executor. Retained on the instance for
	 * integration wiring (task 7.1) even though the wave loop is driven
	 * directly by the executor (task 5.3); defaults to undefined.
	 */
	asyncExecutor?: unknown;
	/** Logger; defaults to a no-op logger so the executor is constructable standalone. */
	logger?: Logger;
	/**
	 * Optional event log for recording step lifecycle transitions (task 7.4).
	 * When provided, the executor appends "dag-step" events for each step
	 * status transition (running, completed, failed, skipped, cancelled) with
	 * data including dagId, stepId, agent, status, and durationMs.
	 */
	eventLog?: { append(type: string, data: Record<string, unknown>): void };
}

/** No-op default logger so the executor is safe to build without one. */
const noopLogger = createNoopLogger();

/** Summary returned by {@link DagExecutor.cancel} (specs/dag-monitoring). */
export interface DagCancelSummary {
	/** Steps that had already reached `completed` at cancel time. */
	completed: number;
	/** Steps that were `running` (in-flight) at cancel time and got aborted. */
	aborted: number;
	/** Steps that were `pending` at cancel time and got marked `cancelled`. */
	cancelled: number;
}

export class DagExecutor {
	/** File-backed DAG + step state persistence. */
	readonly store: DagStore;
	/** Template variable interpolation for step prompts. */
	readonly resolver: TemplateResolver;
	/** Existing agent coordinator used for per-step `delegate()` dispatch. */
	readonly coordinator: AgentCoordinator;
	/** Existing per-agent circuit breaker consulted before each dispatch. */
	readonly circuitBreaker: AcpCircuitBreaker;
	/** Optional async executor wired from `index.ts` (task 7.1). */
	readonly asyncExecutor: unknown;
	/** Logger for step lifecycle / wave / resume events. */
	protected readonly logger: Logger;
	/**
	 * Optional event log for recording step lifecycle transitions (task 7.4).
	 * Appends "dag-step" events for each step status change with data including
	 * dagId, stepId, agent, status, and durationMs.
	 */
	protected readonly eventLog?: { append(type: string, data: Record<string, unknown>): void };
	/**
	 * In-flight abort controllers keyed by `dagId` → `stepId`. Registered by
	 * {@link DagExecutor.dispatchStep} before each dispatch so {@link
	 * DagExecutor.cancel} (task 5.9) can abort in-flight agent sessions.
	 *
	 * This registry is SHARED across all DagExecutor instances (module-level
	 * singleton, see {@link SHARED_ABORT_CONTROLLERS}). In-flight agent
	 * sessions exist independent of which executor instance dispatched them
	 * or processes the cancel — `index.ts` constructs a fresh DagExecutor per
	 * tool call (task 7.1 wiring), so a per-instance map would leave
	 * `acp_dag_cancel` unable to abort sessions dispatched by the
	 * `acp_dag_submit` executor. Sharing the registry keeps cancellation
	 * working end-to-end (specs/dag-monitoring "DAG cancellation").
	 */
	protected readonly abortControllers = SHARED_ABORT_CONTROLLERS;

	/**
	 * Group DAG tasks into ordered execution waves (design.md D2 / task 5.2).
	 *
	 * Wave 0 contains every task with no dependencies. Each subsequent task
	 * is assigned to the wave immediately after the latest wave any of its
	 * dependencies landed in. All tasks sharing the same wave index form one
	 * wave and dispatch in parallel by {@link DagExecutor.execute} (task 5.3).
	 *
	 * This mirrors dorkestrator's `buildExecutionWaves()` and pi-taskflow's
	 * phase-by-phase model. The input array is treated as read-only — the
	 * caller's array and its task objects are not mutated.
	 *
	 * @param tasks Declarative DAG task definitions (already validated — no
	 *   cycles, no dangling refs; see {@link DagValidator}).
	 * @returns An ordered array of waves; each wave is an array of step IDs.
	 *   Empty input yields an empty array.
	 */
	topologicalSort(tasks: readonly DagTaskDefinition[]): string[][] {
		if (tasks.length === 0) return [];

		// Map each step id → its (normalized) dependency list.
		const depsOf = new Map<string, string[]>();
		for (const t of tasks) {
			depsOf.set(t.id, [...(t.dependsOn ?? [])]);
		}

		// Longest-path layering: wave(id) = max(wave(dep)) + 1, or 0 if no deps.
		const waveOf = new Map<string, number>();
		const remaining = new Set(depsOf.keys());

		// Iteratively peel off tasks whose dependencies have all been assigned a
		// wave. A validated DAG is a DAG, so this always drains in
		// (number of waves) passes at most.
		let progressed = true;
		while (remaining.size > 0 && progressed) {
			progressed = false;
			for (const id of remaining) {
				const deps = depsOf.get(id)!;
				if (!deps.every((d) => waveOf.has(d))) continue;
				const wave = deps.reduce((m, d) => Math.max(m, waveOf.get(d)! + 1), 0);
				waveOf.set(id, wave);
				remaining.delete(id);
				progressed = true;
			}
		}
		if (remaining.size > 0) {
			// Should be unreachable for a validated DAG (cycles/dangling refs are
			// caught by DagValidator before execution). Surface defensively.
			throw new Error(
				`DagExecutor.topologicalSort: unresolved dependencies for steps: ${[
					...remaining,
				].join(", ")}`,
			);
		}

		// Preserve the input declaration order within each wave for determinism.
		const maxWave = Math.max(...waveOf.values());
		const waves: string[][] = Array.from({ length: maxWave + 1 }, () => []);
		for (const t of tasks) {
			waves[waveOf.get(t.id)!].push(t.id);
		}
		return waves;
	}

	constructor(options: DagExecutorOptions) {
		this.store = options.store;
		this.resolver = options.resolver;
		this.coordinator = options.coordinator;
		this.circuitBreaker = options.circuitBreaker;
		this.asyncExecutor = options.asyncExecutor;
		this.logger = options.logger ?? noopLogger;
		this.eventLog = options.eventLog;
	}

	/**
	 * Execute a DAG to completion, wave by wave (task 5.3).
	 *
	 * Loads the persisted DAG, transitions it to `running`, computes waves via
	 * {@link DagExecutor.topologicalSort}, then for each wave dispatches every
	 * step **in parallel** directly through {@link AgentCoordinator.delegate}
	 * (the executor owns the wave loop — it does NOT delegate dispatch to
	 * `AsyncExecutor`, per design.md D2 / task 5.3). It waits for the entire
	 * wave to reach a terminal state before advancing, capturing each step's
	 * output (or error) into the persisted record via {@link DagStore.updateStep}
	 * so downstream waves can resolve `{<step>.output}` template variables.
	 *
	 * After the last wave the DAG transitions to `completed` when every step
	 * succeeded, or `failed` otherwise.
	 *
	 * @param dagId DAG to execute.
	 * @param options Optional execution flags. `skipTerminal` (task 5.10)
	 *   leaves steps already in a terminal state untouched instead of
	 *   re-dispatching them — used by {@link DagExecutor.resume} so persisted
	 *   outputs feed downstream template resolution.
	 */
	async execute(
		dagId: string,
		options?: { skipTerminal?: boolean },
	): Promise<void> {
		const record = this.store.get(dagId);
		if (!record) {
			throw new Error(`DAG "${dagId}" not found`);
		}

		// Re-hydrate the persisted step states into a working snapshot the wave
		// loop reads from. Steps already terminal (e.g. completed on resume)
		// are left untouched and their stored outputs feed template resolution.
		const steps: Record<string, DagStepRecord> = {};
		for (const stepId of Object.keys(record.steps)) {
			steps[stepId] = { ...record.steps[stepId] };
		}

		const waves = this.topologicalSort(record.tasks);
		this.store.updateDagStatus(dagId, "running");

		for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
			const waveStepIds = waves[waveIndex];
			await this.runWave(dagId, record, steps, waveStepIds, options);

			// If the DAG was cancelled mid-execution (task 5.9), stop advancing —
			// `cancel()` owns the transition to `cancelled` and we MUST NOT
			// overwrite it with a completion-derived status.
			if (this.store.get(dagId)?.status === "cancelled") return;
		}

		// DAG completion detection (task 5.8): when every step has reached a
		// terminal state, transition the DAG to `completed` or `failed`.
		const terminalStatus = this.detectCompletion(steps);
		if (terminalStatus !== null) {
			this.store.updateDagStatus(dagId, terminalStatus);
		}
	}

	/**
	 * Resume a previously-interrupted DAG (task 5.10, specs/dag-resume "Resume
	 * from last checkpoint after pi restart").
	 *
	 * On pi restart the extension calls {@link DagExecutor.resumeAll} which
	 * discovers DAGs persisted in `running` state and resumes each via this
	 * method. Resume:
	 *
	 *  1. Resets every step still marked `running` back to `pending` — it was
	 *     interrupted mid-flight and its outcome is unknown, so it must be
	 *     retried (specs/dag-resume scenario "Resume a DAG interrupted by pi
	 *     restart").
	 *  2. Re-runs the wave loop via {@link DagExecutor.execute} with
	 *     `skipTerminal: true`, so steps already `completed` / `failed` /
	 *     `skipped` / `cancelled` are NOT re-dispatched — their persisted
	 *     outputs feed downstream template resolution (specs/dag-resume
	 *     scenario "Skip already-completed steps on resume").
	 *
	 * Throws when the DAG does not exist (mirrors {@link DagExecutor.execute}).
	 *
	 * @param dagId DAG to resume.
	 */
	async resume(dagId: string): Promise<void> {
		const record = this.store.get(dagId);
		if (!record) {
			throw new Error(`DAG "${dagId}" not found`);
		}

		// Reset every step still marked `running` back to `pending`. A `running`
		// step at resume time was interrupted mid-flight — its outcome is
		// unknown, so it must be retried from scratch.
		for (const stepId of Object.keys(record.steps)) {
			const step = record.steps[stepId];
			if (step.status === "running") {
				this.store.updateStep(dagId, stepId, (s) => ({
					...s,
					status: "pending",
					startedAt: undefined,
				}));
			}
		}

		// Re-run the wave loop, skipping steps already in a terminal state.
		// `execute` reloads the (now-reset) record from the store, so the
		// snapshot it builds reflects the resets above.
		await this.execute(dagId, { skipTerminal: true });
	}

	/**
	 * Resume every DAG persisted in `running` state (task 5.10, task 7.3).
	 *
	 * This is the startup hook invoked by the extension on load: it scans
	 * `~/.pi/acp-agents/dag/` via {@link DagStore.findRunning} and resumes each
	 * discovered DAG through {@link DagExecutor.resume}. `stale` DAGs are
	 * naturally excluded — `findRunning` only returns `running` DAGs (task
	 * 5.11 / specs/dag-resume "Stale DAG does not auto-resume").
	 *
	 * A single DAG that fails to resume (e.g. an unreadable step record) does
	 * NOT abort the pass — the error is logged and the remaining DAGs still
	 * resume. Returns the list of DAG IDs that were attempted.
	 */
	async resumeAll(): Promise<string[]> {
		const running = this.store.findRunning();
		const resumed: string[] = [];
		for (const record of running) {
			try {
				await this.resume(record.dagId);
			} catch (err) {
				// One bad DAG must not abort the resume pass — log and continue.
				const message = err instanceof Error ? err.message : String(err);
				this.logger.error(
					`DagExecutor.resumeAll: failed to resume DAG "${record.dagId}": ${message}`,
				);
			}
			resumed.push(record.dagId);
		}
		return resumed;
	}

	/**
	 * DAG completion detection (task 5.8, specs/dag-execution "DAG state
	 * transitions"). Returns the DAG-level terminal status once every step
	 * has reached a terminal state, or `null` while at least one step is
	 * still `pending`/`running` (the DAG is not yet done).
	 *
	 * - Returns `"completed"` when every step is `completed`.
	 * - Returns `"failed"` when any step is `failed`, `skipped`, or
	 *   `cancelled` (the run as a whole did not succeed; a `cancelled` step
	 *   from the cancel path (task 5.9) is also a non-success terminal state).
	 * - Returns `null` while any step is still non-terminal.
	 *
	 * An empty step set is vacuously complete (`"completed"`).
	 *
	 * This is a pure function over the supplied step map — it does not read
	 * from or mutate the {@link DagStore}, which keeps it trivially testable
	 * and reusable by the cancel/resume paths.
	 */
	detectCompletion(
		steps: Record<string, DagStepRecord>,
	): DagStatus | null {
		const records = Object.values(steps);
		if (!records.every((s) => isTerminal(s.status))) return null;
		const anyFailure = records.some(
			(s) =>
				s.status === "failed" ||
				s.status === "skipped" ||
				s.status === "cancelled",
		);
		return anyFailure ? "failed" : "completed";
	}

	/**
	 * Dispatch every step in a single wave in parallel, await all of them,
	 * and persist the captured output/error per step. Mutates `steps` to
	 * reflect terminal states.
	 *
	 * Gate evaluation (task 5.5, design.md D4): before dispatching a step,
	 * consult {@link DagExecutor.gateAllowsDispatch}. A `needs` gate is only
	 * satisfied when every dependency `completed`; a dependency that did not
	 * `complete` (e.g. `failed`) blocks the downstream step and it is marked
	 * `skipped` without dispatching. An `after` gate is satisfied as soon as
	 * the dependency is in any terminal state, so the downstream step runs
	 * regardless of the dependency's outcome.
	 */
	private async runWave(
		dagId: string,
		record: DagRecord,
		steps: Record<string, DagStepRecord>,
		waveStepIds: string[],
		options?: { skipTerminal?: boolean },
	): Promise<void> {
		// Build the template context from already-terminal steps (their outputs
		// and statuses), plus the workflow-level args. Pre-computing here keeps
		// every parallel dispatch within the wave on equal footing.
		const outputs = collectOutputs(steps);
		const statuses = collectStatuses(steps);
		const dagArgs = record.args ?? {};

		const dispatches = waveStepIds.map(async (stepId) => {
			const step = steps[stepId];
			if (!step) return undefined;

			// Resume (task 5.10): steps already in a terminal state (e.g.
			// `completed` on resume) are NOT re-dispatched — their stored
			// outputs feed downstream template resolution instead.
			if (options?.skipTerminal && isTerminal(step.status)) {
				return undefined;
			}

			// Gate evaluation (task 5.5) + failFast (task 5.6, design.md D5).
			// A `needs` gate whose dependency did not `complete` is not
			// satisfiable: skip the step instead of dispatching — UNLESS the DAG
			// is running with `failFast: false`, in which case a failed
			// dependency is treated like an `after` gate and the step still
			// dispatches (receiving the dep's error message as `{<dep>.output}`,.
			// surfaced by `collectOutputs`).
			const failFast = record.options?.failFast !== false;
			if (!this.gateAllowsDispatch(step, steps, failFast)) {
				return this.skipStep(dagId, step);
			}

			const resolvedPrompt = this.resolver.resolve(
				step.prompt,
				outputs,
				statuses,
				dagArgs,
			);
			return this.dispatchStep(dagId, step, resolvedPrompt, {
				maxRetries: record.options?.maxRetries ?? 0,
			});
		});

		const settled = await Promise.allSettled(dispatches);

		// Mirror the dispatched results back into the working snapshot so the
		// next wave's template resolution sees them.
		settled.forEach((result, i) => {
			const stepId = waveStepIds[i];
			if (result.status === "fulfilled" && result.value) {
				steps[stepId] = result.value;
			}
		});
	}

	/**
	 * Gate evaluation (task 5.5, design.md D4). Returns whether `step`'s gate
	 * is satisfied given the current step states, i.e. whether the step may be
	 * dispatched in this wave.
	 * - `needs` gate: every dependency MUST be `completed`. Any other dep
	 *   state (including `failed`) blocks dispatch — unless `failFast` is
	 *   `false`, in which case a failed dependency is treated like `after`
	 *   (task 5.6, design.md D5) and dispatch proceeds with the error text
	 *   surfaced as `{<dep>.output}`.
	 * - `after` gate: every dependency MUST be in a terminal state
	 *   (`completed`, `failed`, `skipped`, or `cancelled`) — outcome is
	 *   irrelevant. This lets audit/review steps run on failure evidence.
	 *
	 * Steps with no dependencies always pass (their gate is vacuously true).
	 *
	 * @param failFast DAG-level failFast flag (defaults to `true`). When
	 *   `false`, failed `needs`-gate dependencies do not block dispatch.
	 */
	gateAllowsDispatch(
		step: DagStepRecord,
		steps: Record<string, DagStepRecord>,
		failFast = true,
	): boolean {
		const deps = step.dependsOn ?? [];
		if (deps.length === 0) return true;

		if (step.gate === "after") {
			return deps.every((depId) => isTerminal(steps[depId]?.status));
		}
		// Default gate is `needs`. With failFast=false a failed dependency is
		// treated like `after` — the step still dispatches.
		if (!failFast) {
			return deps.every((depId) => isTerminal(steps[depId]?.status));
		}
		return deps.every((depId) => steps[depId]?.status === "completed");
	}

	/**
	 * Mark a step `skipped` without dispatching it, persisting the transition
	 * through {@link DagStore.updateStep}. Used when a `needs` gate blocks the
	 * step because a dependency did not `complete` (task 5.5; the broader
	 * failFast transitive skip propagation is task 5.6).
	 */
	private skipStep(dagId: string, step: DagStepRecord): DagStepRecord {
		const completedAt = new Date().toISOString();
		const updated = this.store.updateStep(dagId, step.id, (s) => ({
			...s,
			status: "skipped",
			output: null,
			completedAt,
		}));
		this.logStepEvent(dagId, step, "skipped", 0);
		return (
			updated ?? {
				...step,
				status: "skipped",
				output: null,
				completedAt,
			}
		);
	}

	/**
	 * Dispatch one step via {@link AgentCoordinator.delegate}, capturing the
	 * result text on success or the error message on failure. Persists the
	 * terminal transition through {@link DagStore.updateStep} and returns the
	 * updated step record.
	 *
	 * Circuit-breaker check (task 5.7, design.md R3): before dispatching, the
	 * executor consults {@link AcpCircuitBreaker.isHealthy}. An open circuit
	 * fails the step immediately with
	 * `Agent "<name>" is unavailable (circuit breaker open)` —
	 * `coordinator.delegate` is NOT called, mirroring
	 * specs/dag-execution "Step dispatch via AgentCoordinator".
	 */
	private async dispatchStep(
		dagId: string,
		step: DagStepRecord,
		resolvedPrompt: string,
		retryOptions?: { maxRetries?: number },
	): Promise<DagStepRecord> {
		// Circuit breaker check (task 5.7). An open circuit fails the step
		// immediately without dispatching — protects the wave loop from
		// hammering a known-unhealthy agent (design.md R3).
		if (!this.circuitBreaker.isHealthy(step.agent)) {
			const error = `Agent "${step.agent}" is unavailable (circuit breaker open)`;
			const completedAt = new Date().toISOString();
			const updated = this.store.updateStep(dagId, step.id, (s) => ({
				...s,
				status: "failed",
				output: null,
				error,
				completedAt,
				durationMs: 0,
			}));
			this.logStepEvent(dagId, step, "failed", 0);
			return (
				updated ?? {
					...step,
					status: "failed",
					output: null,
					error,
					completedAt,
					durationMs: 0,
				}
			);
		}

		const startedAt = new Date().toISOString();
		this.store.updateStep(dagId, step.id, (s) => ({
			...s,
			status: "running",
			startedAt,
		}));
		this.logStepEvent(dagId, step, "running");

		// Register an AbortController so `cancel(dagId)` (task 5.9) can abort
		// this in-flight agent session. The coordinator forwards the signal
		// to the adapter, which cancels + disposes the session (best-effort).
		const controller = this.registerAbortController(dagId, step.id);
		const signal = controller.signal;

		try {
			const result = await this.coordinator.delegate(
				step.agent,
				resolvedPrompt,
				undefined,
				undefined,
				signal,
			);
			const completedAt = new Date().toISOString();
			const durationMs =
				Date.parse(completedAt) - Date.parse(startedAt);
			const updated = this.store.updateStep(dagId, step.id, (s) => ({
				...s,
				status: "completed",
				output: result.text,
				error: undefined,
				completedAt,
				durationMs,
			}));
			this.logStepEvent(dagId, step, "completed", durationMs);
			return (
				updated ?? {
					...step,
					status: "completed",
					output: result.text,
					completedAt,
					durationMs,
				}
			);
		} catch (err) {
			this.unregisterAbortController(dagId, step.id);

			// AbortError means `cancel()` aborted this in-flight session (task
			// 5.9, specs/dag-monitoring "best-effort for in-flight steps"). The
			// step transitions to `cancelled` (not `failed`) so its terminal
			// state reflects the cancellation outcome.
			if (isAbortError(err)) {
				const completedAt = new Date().toISOString();
				const durationMs =
					Date.parse(completedAt) - Date.parse(startedAt);
				const updated = this.store.updateStep(dagId, step.id, (s) => ({
					...s,
					status: "cancelled",
					output: null,
					error: undefined,
					completedAt,
					durationMs,
				}));
				this.logStepEvent(dagId, step, "cancelled", durationMs);
				return (
					updated ?? {
						...step,
						status: "cancelled",
						output: null,
						completedAt,
						durationMs,
					}
				);
			}

			const message = err instanceof Error ? err.message : String(err);

			// Step retry logic (task 5.12, design.md D5; specs/dag-submission
			// "DAG options — failFast and maxRetries"). On failure, when
			// `maxRetries > 0` and the step's `retryCount` is still below the
			// budget, increment `retryCount`, persist the step back to
			// `running`, and re-dispatch the same resolved prompt. Once the
			// budget is exhausted the step stays `failed`.
			const maxRetries = retryOptions?.maxRetries ?? 0;
			const currentRetries = step.retryCount ?? 0;
			if (maxRetries > 0 && currentRetries < maxRetries) {
				const retriedStep = this.recordRetry(dagId, step, currentRetries);
				return this.dispatchStep(dagId, retriedStep, resolvedPrompt, {
					maxRetries,
				});
			}

			const completedAt = new Date().toISOString();
			const durationMs =
				Date.parse(completedAt) - Date.parse(startedAt);
			const updated = this.store.updateStep(dagId, step.id, (s) => ({
				...s,
				status: "failed",
				output: null,
				error: message,
				completedAt,
				durationMs,
			}));
			this.logStepEvent(dagId, step, "failed", durationMs);
			return (
				updated ?? {
					...step,
					status: "failed",
					error: message,
					completedAt,
					durationMs,
				}
			);
		}
		finally {
			// Always release the in-flight controller entry once the dispatch
			// settles, regardless of outcome (completed/cancelled/failed).
			this.unregisterAbortController(dagId, step.id);
		}
	}

	/**
	 * Record a retry attempt for a failed step (task 5.12). Increments the
	 * step's `retryCount`, resets its status to `running` (the dispatch
	 * loop will re-attempt it), and persists the transition through
	 * {@link DagStore.updateStep}. Returns the updated step record so the
	 * caller can chain the re-dispatch.
	 */
	protected recordRetry(
		dagId: string,
		step: DagStepRecord,
		currentRetries: number,
	): DagStepRecord {
		const startedAt = new Date().toISOString();
		const updated = this.store.updateStep(dagId, step.id, (s) => ({
			...s,
			status: "running",
			retryCount: currentRetries + 1,
			startedAt,
			error: undefined,
			output: null,
			completedAt: undefined,
			durationMs: undefined,
		}));
		return (
			updated ?? {
				...step,
				status: "running",
				retryCount: currentRetries + 1,
				startedAt,
				error: undefined,
				output: null,
				completedAt: undefined,
				durationMs: undefined,
			}
		);
	}

	/**
	 * Cancel a running DAG (task 5.9, specs/dag-monitoring "DAG cancellation").
	 *
	 * Aborts every in-flight agent session (via the abort signal threaded
	 * through {@link AgentCoordinator.delegate}), marks all `pending` and
	 * `running` steps as `cancelled`, transitions the DAG to `cancelled`, and
	 * returns a summary of the cancellation.
	 *
	 * The summary counts reflect the step states AT cancel time:
	 *  - `completed` — steps that had already reached `completed` (untouched)
	 *  - `aborted`    — steps that were `running` (in-flight) and got aborted
	 *  - `cancelled`  — steps that were `pending` and got marked `cancelled`
	 *
	 * A step that finishes successfully between the abort signal firing and
	 * the step being persisted reflects its actual outcome (best-effort),
	 * per specs/dag-monitoring "Cancel is best-effort for in-flight steps".
	 *
	 * @throws when the DAG does not exist, or is already in a terminal state
	 *   (`completed` / `failed` / `cancelled`).
	 */
	async cancel(dagId: string): Promise<DagCancelSummary> {
		const record = this.store.get(dagId);
		if (!record) {
			throw new Error(`DAG "${dagId}" not found`);
		}
		if (
			record.status === "completed" ||
			record.status === "failed" ||
			record.status === "cancelled"
		) {
			throw new Error(
				`DAG "${dagId}" is already ${record.status} and cannot be cancelled`,
			);
		}

		// Tally counts from the persisted step states at cancel time.
		let completed = 0;
		let aborted = 0;
		let cancelled = 0;
		for (const step of Object.values(record.steps)) {
			if (step.status === "completed") completed += 1;
			else if (step.status === "running") aborted += 1;
			else if (step.status === "pending") cancelled += 1;
		}

		// Abort every in-flight agent session for this DAG (best-effort).
		this.abortInFlight(dagId);

		// Mark every pending + running step as `cancelled` and persist.
		const completedAt = new Date().toISOString();
		for (const stepId of Object.keys(record.steps)) {
			const step = record.steps[stepId];
			if (step.status === "pending" || step.status === "running") {
				this.store.updateStep(dagId, stepId, (s) => ({
					...s,
					status: "cancelled",
					output: null,
					error: undefined,
					completedAt,
				}));
				this.logStepEvent(dagId, step, "cancelled", 0);
			}
		}

		this.store.updateDagStatus(dagId, "cancelled");

		return { completed, aborted, cancelled };
	}

	/**
	 * Stale DAG detection (task 5.11, specs/dag-resume "Stale DAG cleanup").
	 *
	 * Scans all DAGs and marks those in `running` state whose last transition
	 * (`updatedAt`) is older than `timeoutMs` as `stale`. A stale DAG has had
	 * no step transitions for the entire timeout window, indicating the
	 * process likely died or stalled without a clean shutdown.
	 *
	 * Stale DAGs are excluded from auto-resume (specs/dag-resume "Stale DAG
	 * does not auto-resume"), require explicit re-submission, and are reported
	 * in `acp_dag_status` listings. Each marked DAG emits a warning log event.
	 *
	 * Already-stale DAGs are NOT re-marked (idempotent). Terminal DAGs
	 * (`completed` / `failed` / `cancelled`) are unaffected.
	 *
	 * @param timeoutMs Stale threshold in ms (default: `dagStaleTimeoutMs`
	 *   from config, typically 1 hour).
	 * @returns The list of DAG IDs that were newly marked `stale` during
	 *   this call. Empty when no DAGs crossed the threshold.
	 */
	markStale(timeoutMs: number): string[] {
		// `findRunning()` scans the per-DAG `<dagId>.json` files directly
		// (the source of truth for `updatedAt`), not the index summary, so a
		// backdated or out-of-sync index cannot mask a stale DAG.
		const running = this.store.findRunning();
		const cutoff = Date.now() - timeoutMs;
		const marked: string[] = [];

		for (const record of running) {
			const updatedAtMs = Date.parse(record.updatedAt);
			if (Number.isNaN(updatedAtMs)) continue;
			if (updatedAtMs >= cutoff) continue;

			// Transition to `stale` via the store so the index reflects it.
			this.store.updateDagStatus(record.dagId, "stale");
			marked.push(record.dagId);
			this.logger.error(
				`DagExecutor.markStale: DAG "${record.dagId}" marked stale (no transitions for >${timeoutMs}ms)`,
			);
		}

		return marked;
	}

	/**
	 * Emit a `dag-step` lifecycle event to the wired {@link
	 * DagExecutor.eventLog} (task 7.4, specs/dag-monitoring "Event logging for
	 * DAG steps"). One event per step status transition (running, completed,
	 * failed, skipped, cancelled). The data includes `dagId`, `stepId`,
	 * `agent`, `status`, `timestamp`, and `durationMs` (for terminal states).
	 *
	 * No-op when no event log was wired so the executor stays backward
	 * compatible with existing tests/construction sites.
	 */
	protected logStepEvent(
		dagId: string,
		step: { id: string; agent: string },
		status: DagStepStatus,
		durationMs?: number,
	): void {
		if (!this.eventLog) return;
		const data: Record<string, unknown> = {
			dagId,
			stepId: step.id,
			agent: step.agent,
			status,
			timestamp: new Date().toISOString(),
		};
		if (typeof durationMs === "number") {
			data.durationMs = durationMs;
		}
		this.eventLog.append("dag-step", data);
	}

	/**
	 * Register an {@link AbortController} for an in-flight step dispatch so
	 * {@link DagExecutor.cancel} can abort it. Returns the controller so the
	 * dispatch can hand its `signal` to {@link AgentCoordinator.delegate}.
	 */
	protected registerAbortController(
		dagId: string,
		stepId: string,
	): AbortController {
		let byStep = this.abortControllers.get(dagId);
		if (!byStep) {
			byStep = new Map();
			this.abortControllers.set(dagId, byStep);
		}
		const controller = new AbortController();
		byStep.set(stepId, controller);
		return controller;
	}

	/** Remove the abort-controller entry for a settled step dispatch. */
	protected unregisterAbortController(dagId: string, stepId: string): void {
		const byStep = this.abortControllers.get(dagId);
		if (!byStep) return;
		byStep.delete(stepId);
		if (byStep.size === 0) this.abortControllers.delete(dagId);
	}

	/**
	 * Abort every in-flight agent session for a DAG (task 5.9). Best-effort:
	 * firing `abort()` on each registered controller causes the coordinator
	 * to cancel + dispose the underlying session and reject the dispatch
	 * with an `AbortError`, which {@link DagExecutor.dispatchStep} maps to a
	 * `cancelled` terminal status.
	 */
	protected abortInFlight(dagId: string): void {
		const byStep = this.abortControllers.get(dagId);
		if (!byStep) return;
		for (const controller of byStep.values()) {
			try {
				controller.abort();
			} catch {
				/* best-effort — a controller that already aborted is a no-op */
			}
		}
	}
}

/**
 * Module-level shared registry of in-flight abort controllers, keyed by
 * `dagId` → `stepId`. Shared across ALL DagExecutor instances so that an
 * executor constructed for `acp_dag_cancel` can abort sessions dispatched by
 * a different executor constructed for `acp_dag_submit` (task 7.1 wires a
 * fresh DagExecutor per tool call). Keyed by dagId + stepId so concurrent
 * DAGs never collide.
 */
const SHARED_ABORT_CONTROLLERS = new Map<string, Map<string, AbortController>>();

/**
 * Collect `{id → output}` for all terminal steps that have a text output.
 * Kept as a module function so the wave loop reads from a plain snapshot.
 */
function collectOutputs(steps: Record<string, DagStepRecord>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, step] of Object.entries(steps)) {
		if (typeof step.output === "string") {
			out[id] = step.output;
		} else if (step.status === "failed" && step.error) {
			// Allow `{<failed-step>.output}` to surface the error text for
			// `after`-gate / failFast=false downstream steps.
			out[id] = step.error;
		}
	}
	return out;
}

/** Collect `{id → status}` for all terminal steps. */
function collectStatuses(steps: Record<string, DagStepRecord>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, step] of Object.entries(steps)) {
		out[id] = step.status;
	}
	return out;
}

/** Whether a step status is terminal (no further transitions expected). */
function isTerminal(status: DagStepStatus | undefined): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "skipped" ||
		status === "cancelled"
	);
}

/**
 * Whether an error is an `AbortError` raised by aborting an in-flight agent
 * session (coordinator wraps the abort in a `DOMException` with name
 * `"AbortError"`). Used by {@link DagExecutor.dispatchStep} to map an
 * aborted dispatch to a `cancelled` terminal status (task 5.9).
 */
function isAbortError(err: unknown): boolean {
	if (err == null || typeof err !== "object") return false;
	const name = (err as { name?: unknown }).name;
	return name === "AbortError";
}

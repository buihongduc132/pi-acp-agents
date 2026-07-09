/**
 * Failure policy engine — decides what happens when file hooks fail
 * (LD: failure policy section of acp-hooks-impl-spec.md).
 *
 * Actions:
 *   warn            — log only, continue.
 *   followup        — create a followup task assigned to followupOwner.
 *   reopen          — reopen the source task (status → in_progress).
 *   reopen_followup — both reopen + followup.
 *
 * `maxReopensPerTask` cap (default 3): once reached, any reopen-flavored
 * action degrades to `warn`.
 *
 * Task metadata stamp (always applied when the gate fails):
 *   qualityGateStatus          → "failed"
 *   qualityGateFailureCount    → +1
 *   reopenedByQualityGateCount → +1 (only when actually reopened)
 */
import { randomUUID } from "node:crypto";

import type {
	FailureAction,
	FollowupOwner,
	HookContext,
} from "./types.js";

/** Logger interface accepted by applyFailurePolicy. */
export interface PolicyLogger {
	warn: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
}

/** Minimal task shape the policy engine operates on. */
export interface PolicyTask {
	id: string;
	subject: string;
	status: string;
	metadata: {
		qualityGateStatus?: string;
		qualityGateFailureCount: number;
		reopenedByQualityGateCount: number;
		[key: string]: unknown;
	};
}

/** A followup task created by the policy engine. */
export interface FollowupTask {
	id: string;
	parentId: string;
	subject: string;
	owner: string;
	status: string;
}

/** Result returned by applyFailurePolicy. */
export interface PolicyResult {
	action: FailureAction;
	followupTask?: FollowupTask;
	handled: boolean;
}

/** Configurable policy knobs. */
export interface PolicyConfig {
	failureAction: FailureAction;
	maxReopensPerTask: number;
	followupOwner: FollowupOwner;
}

/** Partial runtime override applied on top of the base config. */
export interface PolicyOverride {
	failureAction?: FailureAction;
	maxReopensPerTask?: number;
	followupOwner?: FollowupOwner;
}

/** Parameters for the standalone applyFailurePolicy function. */
export interface ApplyFailurePolicyParams {
	action: FailureAction;
	context: HookContext;
	task: PolicyTask;
	followupOwner?: FollowupOwner;
	maxReopensPerTask?: number;
	logger?: PolicyLogger;
}

const DEFAULT_MAX_REOPENS = 3;
const DEFAULT_FOLLOWUP_OWNER: FollowupOwner = "lead";

const noopLogger: PolicyLogger = {
	warn: () => {},
	info: () => {},
};

/**
 * Create a followup task record for a failed source task.
 */
function createFollowupTask(
	task: PolicyTask,
	owner: FollowupOwner,
): FollowupTask {
	return {
		id: randomUUID(),
		parentId: task.id,
		subject: `Followup: ${task.subject}`,
		owner,
		status: "pending",
	};
}

/**
 * Apply the failure policy to a task whose quality gate failed.
 *
 * Stamps metadata, enforces the reopen cap, and performs the configured
 * side effects (log / create followup / reopen).
 */
export async function applyFailurePolicy(
	params: ApplyFailurePolicyParams,
): Promise<PolicyResult> {
	const {
		action: requestedAction,
		task,
		logger,
	} = params;
	const maxReopens = params.maxReopensPerTask ?? DEFAULT_MAX_REOPENS;
	const owner = params.followupOwner ?? DEFAULT_FOLLOWUP_OWNER;
	const log = logger ?? noopLogger;

	// ── Metadata stamp (always — the gate failed) ──
	task.metadata.qualityGateStatus = "failed";
	task.metadata.qualityGateFailureCount =
		(task.metadata.qualityGateFailureCount ?? 0) + 1;

	// ── Cap check: degrade reopen-flavored actions to warn ──
	let action = requestedAction;
	const involvesReopen =
		action === "reopen" || action === "reopen_followup";
	if (
		involvesReopen &&
		(task.metadata.reopenedByQualityGateCount ?? 0) >= maxReopens
	) {
		log.warn(
			`maxReopensPerTask cap (${maxReopens}) reached for task ${task.id} — forcing warn`,
		);
		action = "warn";
	}

	let followupTask: FollowupTask | undefined;

	switch (action) {
		case "warn":
			log.warn(
				`quality gate failed for task ${task.id} — action: warn`,
			);
			break;

		case "followup":
			followupTask = createFollowupTask(task, owner);
			log.info(
				`created followup task ${followupTask.id} for task ${task.id} (owner: ${owner})`,
			);
			break;

		case "reopen":
			task.status = "in_progress";
			task.metadata.reopenedByQualityGateCount =
				(task.metadata.reopenedByQualityGateCount ?? 0) + 1;
			log.info(`reopened task ${task.id}`);
			break;

		case "reopen_followup":
			task.status = "in_progress";
			task.metadata.reopenedByQualityGateCount =
				(task.metadata.reopenedByQualityGateCount ?? 0) + 1;
			followupTask = createFollowupTask(task, owner);
			log.info(
				`reopened task ${task.id} and created followup ${followupTask.id}`,
			);
			break;
	}

	return { action, followupTask, handled: true };
}

/**
 * Stateful policy engine with runtime overrides.
 *
 * Holds a base (configured) policy and an optional override layer applied
 * at runtime via `setOverride`. `getEffectivePolicy` merges the two.
 */
export class FailurePolicyEngine {
	private readonly base: PolicyConfig;
	private override: PolicyOverride;

	constructor(base: PolicyConfig) {
		this.base = { ...base };
		this.override = {};
	}

	/** Return the effective policy (override wins over base). */
	getEffectivePolicy(): PolicyConfig {
		return {
			failureAction:
				this.override.failureAction ?? this.base.failureAction,
			maxReopensPerTask:
				this.override.maxReopensPerTask ?? this.base.maxReopensPerTask,
			followupOwner:
				this.override.followupOwner ?? this.base.followupOwner,
		};
	}

	/** Return the configured (base) policy, ignoring overrides. */
	getConfiguredPolicy(): PolicyConfig {
		return { ...this.base };
	}

	/** Apply a partial runtime override. */
	setOverride(o: PolicyOverride): void {
		if (o.failureAction !== undefined) {
			this.override.failureAction = o.failureAction;
		}
		if (o.maxReopensPerTask !== undefined) {
			this.override.maxReopensPerTask = o.maxReopensPerTask;
		}
		if (o.followupOwner !== undefined) {
			this.override.followupOwner = o.followupOwner;
		}
	}

	/** Clear all runtime overrides. */
	reset(): void {
		this.override = {};
	}

	/**
	 * Apply the failure policy using the engine's effective config.
	 *
	 * Convenience wrapper around the standalone `applyFailurePolicy`.
	 */
	async applyFailurePolicy(
		action: FailureAction,
		task: PolicyTask,
		context: HookContext,
		logger?: PolicyLogger,
	): Promise<PolicyResult> {
		const eff = this.getEffectivePolicy();
		return applyFailurePolicy({
			action,
			context,
			task,
			followupOwner: eff.followupOwner,
			maxReopensPerTask: eff.maxReopensPerTask,
			logger,
		});
	}
}

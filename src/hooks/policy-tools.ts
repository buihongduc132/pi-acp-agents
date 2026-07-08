/**
 * Policy tool definitions — `acp_hooks_policy_get` / `acp_hooks_policy_set`.
 *
 * These tools expose runtime inspection and mutation of the hooks failure
 * policy. `registerHooksPolicyTools()` wires them into the pi tool registry
 * following the same pattern as the other ACP tools in index.ts.
 *
 * Source of truth: flow/plans/acp-hooks-impl-spec.md (Policy tools section).
 */
import { Type } from "typebox";

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";

import {
	DEFAULT_HOOK_CONFIG,
} from "./types.js";
import type {
	FailureAction,
	FollowupOwner,
} from "./types.js";

/** Valid failure action values. */
export const VALID_FAILURE_ACTIONS: ReadonlySet<string> = new Set([
	"warn",
	"followup",
	"reopen",
	"reopen_followup",
]);

/** Valid followup owner values. */
export const VALID_FOLLOWUP_OWNERS: ReadonlySet<string> = new Set([
	"member",
	"lead",
	"none",
]);

/** Keys the policy store uses. */
const STORE_KEYS = [
	"failureAction",
	"maxReopensPerTask",
	"followupOwner",
] as const;

/** Minimal key/value store interface the tools operate against. */
export interface PolicyStore {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	delete(key: string): void;
}

/** Result shape returned by `acp_hooks_policy_get`. */
export interface GetPolicyResult {
	configured: {
		failureAction: FailureAction;
		maxReopensPerTask: number;
		followupOwner: FollowupOwner;
	};
	effective: {
		failureAction: FailureAction;
		maxReopensPerTask: number;
		followupOwner: FollowupOwner;
	};
}

/** Input for `acp_hooks_policy_set`. */
export interface SetPolicyInput {
	failureAction?: FailureAction;
	maxReopensPerTask?: number;
	followupOwner?: FollowupOwner;
	reset?: boolean;
}

/** Result shape returned by `acp_hooks_policy_set`. */
export interface SetPolicyResult {
	success: boolean;
}

/** Defaults mirror DEFAULT_HOOK_CONFIG (single source: types.ts). */
const DEFAULT_FAILURE_ACTION: FailureAction = DEFAULT_HOOK_CONFIG.failureAction;
const DEFAULT_MAX_REOPENS: number = DEFAULT_HOOK_CONFIG.maxReopensPerTask;
const DEFAULT_FOLLOWUP_OWNER: FollowupOwner = DEFAULT_HOOK_CONFIG.followupOwner;

/** Env var names that override the effective policy at read time. */
const ENV_FAILURE_ACTION = "ACP_HOOKS_FAILURE_ACTION";
const ENV_MAX_REOPENS = "ACP_HOOKS_MAX_REOPENS_PER_TASK";
const ENV_FOLLOWUP_OWNER = "ACP_HOOKS_FOLLOWUP_OWNER";

function readEnvString(name: string): string | undefined {
	const v = process.env[name];
	return v && v.length > 0 ? v : undefined;
}

/**
 * Read the configured (store-backed) policy snapshot.
 */
function readConfigured(store: PolicyStore): GetPolicyResult["configured"] {
	return {
		failureAction:
			(store.get("failureAction") as FailureAction | undefined) ??
			DEFAULT_FAILURE_ACTION,
		maxReopensPerTask:
			(store.get("maxReopensPerTask") as number | undefined) ??
			DEFAULT_MAX_REOPENS,
		followupOwner:
			(store.get("followupOwner") as FollowupOwner | undefined) ??
			DEFAULT_FOLLOWUP_OWNER,
	};
}

/**
 * Read the effective policy: env override > store value > default.
 */
function readEffective(store: PolicyStore): GetPolicyResult["effective"] {
	const configured = readConfigured(store);

	const envFa = readEnvString(ENV_FAILURE_ACTION);
	const envMax = readEnvString(ENV_MAX_REOPENS);
	const envOwner = readEnvString(ENV_FOLLOWUP_OWNER);

	return {
		failureAction:
			envFa && VALID_FAILURE_ACTIONS.has(envFa)
				? (envFa as FailureAction)
				: configured.failureAction,
		maxReopensPerTask:
			envMax !== undefined && Number.isFinite(Number(envMax))
				? Math.max(0, Math.floor(Number(envMax)))
				: configured.maxReopensPerTask,
		followupOwner:
			envOwner && VALID_FOLLOWUP_OWNERS.has(envOwner)
				? (envOwner as FollowupOwner)
				: configured.followupOwner,
	};
}

/**
 * Implementation of `acp_hooks_policy_get` — returns configured + effective policy.
 */
export async function getHooksPolicyTool(
	store: PolicyStore,
): Promise<GetPolicyResult> {
	return {
		configured: readConfigured(store),
		effective: readEffective(store),
	};
}

/** Validate a SetPolicyInput. Throws on any invalid field. */
function validateInput(input: SetPolicyInput): void {
	if (
		input.failureAction !== undefined &&
		!VALID_FAILURE_ACTIONS.has(input.failureAction)
	) {
		throw new Error(
			`invalid failureAction "${String(input.failureAction)}" — must be one of: warn, followup, reopen, reopen_followup`,
		);
	}
	if (
		input.followupOwner !== undefined &&
		!VALID_FOLLOWUP_OWNERS.has(input.followupOwner)
	) {
		throw new Error(
			`invalid followupOwner "${String(input.followupOwner)}" — must be one of: member, lead, none`,
		);
	}
	if (input.maxReopensPerTask !== undefined) {
		const n = input.maxReopensPerTask;
		if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
			throw new Error(
				`invalid maxReopensPerTask ${String(n)} — must be a non-negative integer`,
			);
		}
	}
}

/**
 * Implementation of `acp_hooks_policy_set` — updates the store and/or clears
 * overrides when `reset: true`.
 */
export async function setHooksPolicyTool(
	store: PolicyStore,
	input: SetPolicyInput,
): Promise<SetPolicyResult> {
	validateInput(input);

	if (input.reset) {
		for (const key of STORE_KEYS) {
			store.delete(key);
		}
		return { success: true };
	}

	if (input.failureAction !== undefined) {
		store.set("failureAction", input.failureAction);
	}
	if (input.maxReopensPerTask !== undefined) {
		store.set("maxReopensPerTask", input.maxReopensPerTask);
	}
	if (input.followupOwner !== undefined) {
		store.set("followupOwner", input.followupOwner);
	}

	return { success: true };
}

/** Options for registering the policy tools. */
export interface RegisterHooksPolicyToolsOptions {
	store: PolicyStore;
	/** Guard mirroring isToolEnabled; defaults to always-enabled. */
	isEnabled?: () => boolean;
}

/**
 * Build the `acp_hooks_policy_get` ToolDefinition (without registering).
 */
function buildHooksPolicyGetTool(
	store: PolicyStore,
): ToolDefinition {
	return {
		name: "acp_hooks_policy_get",
		label: "ACP Hooks Policy (get)",
		description:
			"Inspect the ACP hooks failure policy — returns configured and effective values (env overrides applied).",
		promptSnippet:
			"acp_hooks_policy_get — show the current hooks failure policy",
		parameters: Type.Object({}),
		async execute() {
			const result = await getHooksPolicyTool(store);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
				details: result,
			};
		},
	};
}

/**
 * Build the `acp_hooks_policy_set` ToolDefinition (without registering).
 */
function buildHooksPolicySetTool(
	store: PolicyStore,
): ToolDefinition {
	return {
		name: "acp_hooks_policy_set",
		label: "ACP Hooks Policy (set)",
		description:
			"Update the ACP hooks failure policy at runtime. Set hooksPolicyReset=true to clear overrides and restore defaults.",
		promptSnippet:
			"acp_hooks_policy_set — change failureAction / maxReopensPerTask / followupOwner",
		parameters: Type.Object({
			failureAction: Type.Optional(
				Type.String({
					description:
						"One of: warn, followup, reopen, reopen_followup",
				}),
			),
			maxReopensPerTask: Type.Optional(
				Type.Number({
					description: "Non-negative integer cap on reopens per task",
				}),
			),
			followupOwner: Type.Optional(
				Type.String({
					description: "One of: member, lead, none",
				}),
			),
			reset: Type.Optional(
				Type.Boolean({
					description:
						"If true, clear all overrides and restore defaults",
				}),
			),
		}),
		async execute(_id, params) {
			const input = params as SetPolicyInput;
			try {
				const result = await setHooksPolicyTool(store, input);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(result, null, 2),
						},
					],
					details: result,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: String((err as Error).message),
						},
					],
					details: { success: false, error: (err as Error).message },
					isError: true,
				};
			}
		},
	};
}

/**
 * Register both policy tools with the pi tool registry.
 *
 * Mirrors the existing `pi.registerTool` pattern from index.ts.
 */
export function registerHooksPolicyTools(
	pi: ExtensionAPI,
	opts: RegisterHooksPolicyToolsOptions,
): void {
	const enabled = opts.isEnabled ?? (() => true);
	if (!enabled()) return;

	pi.registerTool(buildHooksPolicyGetTool(opts.store));
	pi.registerTool(buildHooksPolicySetTool(opts.store));
}

/**
 * HookDispatcher — 3-phase execution engine (LD6).
 *
 * Phase 1 PRE:    sync pre-hooks (registration order). PreHookResult can
 *                 blockAll (skip entire phase 2) or suppress per-target
 *                 (file/socket/ext) — LD13.
 * Phase 2 PARALLEL: file hooks (runAcpHook) + socket publish + post-hooks
 *                 all run via Promise.all.
 * Phase 3 AGGREGATE: collect file hook exit codes, apply failure policy
 *                 if any failed and a task is present.
 *
 * Source of truth: flow/plans/acp-hooks-impl-spec.md
 */
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

import type {
	FailureAction,
	HookConfig,
	HookContext,
	HookEventName,
	PreHookResult,
	SocketEvent,
} from "./types.js";
import {
	runAcpHook,
	type HookRunResult,
} from "./hooks.js";

/** A target that can be suppressed by a pre-hook (LD13). */
export type SuppressTarget = "file" | "socket" | "ext";

/** Pre/post hook handler signature. */
export type HookHandler = (
	context: HookContext,
) => PreHookResult | Promise<PreHookResult> | void | Promise<void>;

/** Registration for a pre or post hook via `dispatcher.on()`. */
export interface HookRegistration {
	phase: "pre" | "post";
	event: HookEventName;
	handler: HookHandler;
}

/** Optional socket publisher interface (fire-and-forget). */
export interface DispatcherSocketPublisher {
	publish(event: SocketEvent): Promise<boolean> | boolean;
}

/** Optional failure-policy applicator (injectable for testing). */
export type ApplyFailurePolicyFn = (
	action: FailureAction,
	context: HookContext,
) => Promise<{ handled: boolean; action: FailureAction }> | { handled: boolean; action: FailureAction };

/** Constructor options for HookDispatcher. */
export interface HookDispatcherOptions {
	config: HookConfig;
	/** Directory containing file-based hook scripts. */
	hooksDir: string;
	/** Injectable socket publisher (created externally; not required for tests). */
	publisher?: DispatcherSocketPublisher;
	/** Injectable failure-policy applicator. Defaults to a logging no-op. */
	applyFailurePolicy?: ApplyFailurePolicyFn;
	/** Default per-event timeout when not specified in config.hooks[event]. */
	defaultTimeoutMs?: number;
	/** When true, concurrent dispatches for the same event+correlationId are
	 *  skipped (reentrancy guard). Default: false (legacy behavior). */
	enableReentrancyGuard?: boolean;
}

/** Result of a single dispatch. */
export interface DispatchResult {
	/** Per-file hook run results (empty if file hooks suppressed/blocked/none). */
	fileResults: HookRunResult[];
	/** True if a pre-hook returned blockAll. */
	blocked: boolean;
	/** Reason recorded by the blocking pre-hook, if any. */
	blockReason?: string;
	/** True if any file hook exited non-zero. */
	hasFailures: boolean;
	/** True if the failure policy was invoked. */
	policyApplied: boolean;
	/** True if this dispatch was skipped by the reentrancy guard. */
	skipped: boolean;
	/** Reason the dispatch was skipped, if any (e.g. "reentrancy-guard"). */
	skippedReason?: string;
}

/** Argument to `dispatch()`. */
export interface DispatchArgs {
	event: HookEventName;
	context: HookContext;
}

const DEFAULT_TIMEOUT_MS = 5000;
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
	".sh",
	".ps1",
	".js",
	".mjs",
]);

/**
 * Default failure-policy applicator. Real wiring injects the policy.ts
 * engine; this default simply records the action without side effects.
 */
function defaultApplyFailurePolicy(
	action: FailureAction,
	_context: HookContext,
): { handled: boolean; action: FailureAction } {
	return { handled: true, action };
}

/**
 * Discover hook script files directly inside `dir`.
 *
 * Returns absolute paths to regular files that are either executable or
 * carry a known script extension. Non-recursive; ignores directories and
 * config files.
 */
function discoverHookScripts(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const name of entries) {
		// Skip dotfiles and config files.
		if (name.startsWith(".")) continue;
		if (name === "config.json" || name.endsWith(".json")) continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;
		const ext = extname(name).toLowerCase();
		const isExec = (st.mode & 0o111) !== 0;
		if (SCRIPT_EXTENSIONS.has(ext) || isExec) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Build a SocketEvent envelope around a HookContext payload.
 *
 * Stamps publisherPid onto the context so the WakeSubscriber can suppress
 * self-echo (events published by this same process).
 */
function buildSocketEvent(event: HookEventName, context: HookContext): SocketEvent {
	const stamped: HookContext = { ...context, publisherPid: process.pid };
	return {
		"event-type": `acp.${event}`,
		"event-id": context.correlationId,
		timestamp: context.timestamp,
		source: "acp",
		payload: stamped,
	};
}

/**
 * 3-phase hook dispatcher (LD6).
 */
export class HookDispatcher {
	private readonly config: HookConfig;
	private readonly hooksDir: string;
	private readonly publisher?: DispatcherSocketPublisher;
	private readonly applyFailurePolicyFn?: ApplyFailurePolicyFn;
	private readonly defaultTimeoutMs: number;

	private readonly preHooks = new Map<HookEventName, HookHandler[]>();
	private readonly postHooks = new Map<HookEventName, HookHandler[]>();

	/** Reentrancy guard: when enabled, tracks in-flight (event,correlationId) keys. */
	private readonly enableReentrancyGuard: boolean;
	private readonly inFlightKeys = new Set<string>();

	constructor(opts: HookDispatcherOptions) {
		this.config = opts.config;
		this.hooksDir = opts.hooksDir;
		this.publisher = opts.publisher;
		this.applyFailurePolicyFn = opts.applyFailurePolicy;
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.enableReentrancyGuard = opts.enableReentrancyGuard ?? false;
	}

	/** Currently in-flight reentrancy-guard keys (introspection/testing). */
	getInFlightKeys(): string[] {
		return [...this.inFlightKeys];
	}

	/** Register a pre or post hook for an event. */
	on(reg: HookRegistration): void {
		const map = reg.phase === "pre" ? this.preHooks : this.postHooks;
		const list = map.get(reg.event) ?? [];
		list.push(reg.handler);
		map.set(reg.event, list);
	}

	/** Convenience: register a pre-hook. */
	registerPreHook(event: HookEventName, handler: HookHandler): void {
		this.on({ phase: "pre", event, handler });
	}

	/** Convenience: register a post-hook. */
	registerPostHook(event: HookEventName, handler: HookHandler): void {
		this.on({ phase: "post", event, handler });
	}

	/** Convenience alias matching the `fire(event, context)` call shape
	 *  expected by HookTriggerManager and external callers. */
	fire(event: HookEventName, context: HookContext): Promise<DispatchResult> {
		return this.dispatch({ event, context });
	}

	/** Remove all registered hooks. */
	clear(): void {
		this.preHooks.clear();
		this.postHooks.clear();
	}

	/** Main entry point — run the 3-phase pipeline for an event. */
	async dispatch(args: DispatchArgs): Promise<DispatchResult> {
		const { event, context } = args;

		// ── Reentrancy guard: skip if a dispatch for the same key is in flight ──
		const guardKey = `${event}:${context.correlationId}`;
		if (this.enableReentrancyGuard) {
			if (this.inFlightKeys.has(guardKey)) {
				return {
					fileResults: [],
					blocked: false,
					hasFailures: false,
					policyApplied: false,
					skipped: true,
					skippedReason: "reentrancy-guard",
				};
			}
			this.inFlightKeys.add(guardKey);
		}

		try {
			return await this.runPipeline(event, context);
		} finally {
			if (this.enableReentrancyGuard) {
				this.inFlightKeys.delete(guardKey);
			}
		}
	}

	/** Internal 3-phase pipeline (called under the reentrancy guard). */
	private async runPipeline(
		event: HookEventName,
		context: HookContext,
	): Promise<DispatchResult> {
		// ── Phase 1: PRE (registration order; handlers may be async) ──
		const preResult = await this.runPreHooks(event, context);
		if (preResult.blocked) {
			return {
				fileResults: [],
				blocked: true,
				blockReason: preResult.blockReason,
				hasFailures: false,
				policyApplied: false,
				skipped: false,
			};
		}

		// ── Phase 2: PARALLEL ──
		let fileResults: HookRunResult[] = [];
		const parallel: Promise<unknown>[] = [];

		// File hooks
		if (!preResult.suppress.has("file") && this.isEventEnabled(event) && this.config.enabled) {
			const files = discoverHookScripts(this.hooksDir);
			if (files.length > 0) {
				const timeoutMs = this.eventTimeoutMs(event);
				parallel.push(
					Promise.resolve()
						.then(() =>
							runAcpHook(files, { event, context, timeoutMs }),
						)
						.then((res: HookRunResult | { results: HookRunResult[] }) => {
							if ("results" in res && Array.isArray(res.results)) {
								fileResults = res.results;
							} else {
								fileResults = [res as HookRunResult];
							}
						})
						.catch(() => {
							// exception isolation — file hooks never crash dispatch
						}),
				);
			}
		}

		// Socket publish (fire-and-forget)
		if (
			!preResult.suppress.has("socket") &&
			this.config.enabled &&
			this.config.socket.enabled &&
			this.publisher
		) {
			parallel.push(
				Promise.resolve()
					.then(() => this.publisher!.publish(buildSocketEvent(event, context)))
					.catch(() => {
						/* fire-and-forget */
					}),
			);
		}

		// Post hooks (Fix 5: suppress:['ext'] gates post-hooks;
		//  Fix 6: config.enabled gates them too)
		const postHandlers =
			this.config.enabled && !preResult.suppress.has("ext")
				? (this.postHooks.get(event) ?? [])
				: [];
		for (const handler of postHandlers) {
			parallel.push(
				Promise.resolve()
					.then(() => handler(context))
					.catch(() => {
						/* exception isolation */
					}),
			);
		}

		await Promise.all(parallel);

		// ── Phase 3: AGGREGATE ──
		const hasFailures = fileResults.some(
			(r) => r.exitCode !== 0 || r.timedOut,
		);
		let policyApplied = false;
		if (hasFailures && context.task) {
			const fn = this.applyFailurePolicyFn ?? defaultApplyFailurePolicy;
			try {
				await fn(this.config.failureAction, context);
			} catch {
				/* never let policy errors escape */
			}
			policyApplied = true;
		}

			return {
				fileResults,
				blocked: false,
				hasFailures,
				policyApplied,
				skipped: false,
			};
	}

	/** Run pre-hooks in order; merge their PreHookResults. */
	private async runPreHooks(
		event: HookEventName,
		context: HookContext,
	): Promise<{ blocked: boolean; blockReason?: string; suppress: Set<SuppressTarget> }> {
		const suppress = new Set<SuppressTarget>();
		const handlers = this.preHooks.get(event) ?? [];
		for (const handler of handlers) {
			let res: PreHookResult | void;
			try {
				res = await handler(context);
			} catch {
				continue;
			}
			// Allow sync void return
			const resolved = res as PreHookResult | undefined;
			if (!resolved) continue;
			if (resolved.blockAll) {
				return {
					blocked: true,
					blockReason: resolved.reason,
					suppress,
				};
			}
			if (resolved.suppress) {
				for (const t of resolved.suppress) {
					suppress.add(t);
				}
			}
		}
		return { blocked: false, suppress };
	}

	private isEventEnabled(event: HookEventName): boolean {
		const entry = this.config.hooks[event];
		return entry?.enabled ?? true;
	}

	private eventTimeoutMs(event: HookEventName): number {
		const entry = this.config.hooks[event];
		const ms = entry?.timeoutMs;
		if (typeof ms === "number" && ms > 0) return ms;
		return this.defaultTimeoutMs;
	}
}

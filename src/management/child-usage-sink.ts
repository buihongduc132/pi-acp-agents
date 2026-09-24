/**
 * child-usage sink — mirror worker usage to a shared sink file.
 *
 * Writes a single JSON object to <sinkDir>/<childSessionId>.json so external
 * apps can read ACP child-agent token/duration data from ONE place.
 *
 * Canonical contract:
 *   flow/findings/2026-07-17-unify-child-usage/solutions/child-usage-schema-contract.md
 *
 * Write semantics (per contract):
 *  1. Idempotent merge — read existing, replace ONLY fields ACP owns; never
 *     null-out foreign fields another writer may have set.
 *  2. Absolute totals — caller passes the new cumulative total (NOT a delta).
 *  3. Atomic write — write <file>.tmp then rename; readers never see torn JSON.
 *  4. Non-blocking — any FS failure is debug-logged + swallowed. Usage tracking
 *     MUST NOT break the sub-agent runtime (AGENTS.md hook exception-safety).
 *
 * ACP does not receive per-turn events, so `turns` is always 0 (documented in
 * code; the field is still written to satisfy the shared schema).
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNoopLogger } from "../logger.js";
import { getChildUsageDir } from "./runtime-paths.js";
import { safeMkdir } from "./safe-mkdir.js";
import type { ChildUsageRecord, ChildUsageSource } from "../config/types.js";

const log = createNoopLogger();

const SCHEMA_VERSION = 1 as const;

/** Fields ACP supplies when mirroring worker usage. */
export interface ChildUsageInput {
	/** Stable per-spawn session id (matches sink filename). REQUIRED. */
	childSessionId: string;
	/** Leader/pi session owning this worker. null if unknown. */
	parentSessionId: string | null;
	/** Which plugin wrote this record. */
	source: ChildUsageSource;
	/** Cumulative token count (ABSOLUTE, not delta). */
	tokensTotal: number;
	/** Cumulative tool-call count (ABSOLUTE, not delta). */
	toolCalls: number;
	/** Turn count — ACP has no per-turn events, always 0. */
	turns: number;
	/** ISO 8601 UTC first-spawn timestamp. */
	startedAt: string;
	/**
	 * ISO 8601 UTC terminal timestamp. Omit/undefined = leave existing endedAt
	 * untouched. Pass null to explicitly clear (ACP does NOT do this).
	 * When provided (truthy), durationMs is recomputed as endedAt - startedAt.
	 */
	endedAt?: string | null;
}

export interface WriteOptions {
	/** Explicit sink directory override (tests). Defaults to getChildUsageDir(). */
	dir?: string;
}

/** Resolve sink dir (exported for callers / tests). */
export function resolveSinkDir(explicit?: string): string {
	return getChildUsageDir(explicit);
}

/** Compute wall-clock duration in ms between two ISO timestamps (>= 0). */
function computeDurationMs(startedAt: string | null, endedAt: string | null): number {
	if (!startedAt || !endedAt) return 0;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (Number.isNaN(start) || Number.isNaN(end)) return 0;
	return Math.max(0, end - start);
}

/** Read + parse existing sink record, or null if missing/invalid. */
function readExisting(filePath: string): Partial<ChildUsageRecord> & Record<string, unknown> | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as Partial<ChildUsageRecord> & Record<string, unknown>;
	} catch (e) {
		// Corrupt or unreadable — treat as missing so we can rewrite cleanly.
		log.debug("child-usage-sink read failed", e);
		return null;
	}
}

/** Public reader for tests / external consumers. Returns null if absent/invalid. */
export function readChildUsage(
	childSessionId: string,
	opts?: WriteOptions,
): ChildUsageRecord | null {
	if (!childSessionId) return null;
	const dir = resolveSinkDir(opts?.dir);
	const filePath = join(dir, `${childSessionId}.json`);
	const existing = readExisting(filePath);
	if (!existing) return null;
	return existing as unknown as ChildUsageRecord;
}

/**
 * Mirror-write worker usage to the shared sink file. NON-BLOCKING on FS errors.
 *
 * Idempotent merge: foreign fields another writer set are PRESERVED. Only
 * ACP-owned schema fields are overwritten.
 */
export function writeChildUsage(input: ChildUsageInput, opts?: WriteOptions): void {
	// Never fabricate a childSessionId — skip silently if absent.
	if (!input.childSessionId || input.childSessionId.trim() === "") {
		log.debug("child-usage-sink: skipping write — childSessionId missing");
		return;
	}

	let dir: string;
	let filePath: string;
	let tmpPath: string;
	try {
		dir = resolveSinkDir(opts?.dir);
		safeMkdir(dir);
		filePath = join(dir, `${input.childSessionId}.json`);
		tmpPath = `${filePath}.tmp`;
	} catch (e) {
		log.debug("child-usage-sink: dir resolve/mkdir failed", e);
		return;
	}

	const existing = readExisting(filePath) ?? {};
	const now = new Date().toISOString();

	// ── Merge: overwrite ONLY ACP-owned fields; preserve everything else. ──
	const merged: Record<string, unknown> = { ...existing };

	// Identity + schema
	merged.schemaVersion = SCHEMA_VERSION;
	merged.childSessionId = input.childSessionId;
	merged.parentSessionId = input.parentSessionId;
	merged.source = input.source;

	// Usage aggregate (absolute totals)
	merged.tokensTotal = input.tokensTotal;
	merged.toolCalls = input.toolCalls;
	merged.turns = input.turns;

	// Duration scope hedge
	merged.durationScope = "wallclock";

	// Lifecycle timestamps
	merged.startedAt = input.startedAt;
	merged.updatedAt = now;

	// endedAt handling — never null-out unless caller explicitly clears.
	if (input.endedAt !== undefined) {
		merged.endedAt = input.endedAt;
	} else if (existing.endedAt === undefined) {
		// First write with no terminal time → null (running).
		merged.endedAt = null;
	}
	// else: preserve existing endedAt value (could be null or a real timestamp).

	const endedAt = (merged.endedAt as string | null) ?? null;
	merged.durationMs = computeDurationMs(
		typeof merged.startedAt === "string" ? merged.startedAt : null,
		endedAt,
	);

	// ── Atomic write: <file>.tmp then rename. ──
	try {
		writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
		renameSync(tmpPath, filePath);
	} catch (e) {
		// FS failure — debug-log + swallow. NEVER break the runtime.
		log.debug("child-usage-sink write failed", e);
		// Best-effort tmp cleanup; ignore failure.
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {
			/* swallow */
		}
	}
}

export { getChildUsageDir };

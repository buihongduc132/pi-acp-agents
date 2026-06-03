/**
 * safe-mkdir — Ownership-aware directory creation for pi extensions
 *
 * Guarantees that created directories are owned by the current user.
 * Detects root-owned directories (e.g. from sudo test runs) and warns
 * with a clear fix command instead of silently failing later with EACCES.
 *
 * All pi extensions that create directories under ~/.pi/ MUST use this
 * instead of bare `mkdirSync`.
 */
// @ts-nocheck

import { mkdirSync, statSync } from "node:fs";
import { createNoopLogger } from "../logger.js";

const log = createNoopLogger();

/**
 * Create a directory with current-user ownership guarantee.
 *
 * - If the dir doesn't exist: creates it with mode 0o755
 * - If the dir exists but is owned by another user: warns with fix command
 * - If the dir exists and is owned by current user: no-op
 *
 * @param dirPath - Absolute path to create
 * @param options - Optional mkdirSync options (mode defaults to 0o755)
 */
export function safeMkdir(
	dirPath: string,
	options?: { mode?: number },
): void {
	const mode = options?.mode ?? 0o755;
	mkdirSync(dirPath, { recursive: true, mode });

	// Ownership check — detect root-owned dirs from sudo runs
	try {
		const stat = statSync(dirPath);
		if (stat.uid !== process.getuid()) {
			console.warn(
				`[pi] WARNING: Directory ${dirPath} is owned by uid ${stat.uid}, ` +
				`but pi runs as uid ${process.getuid()}. ` +
				`Fix: sudo chown -R $(whoami) ${dirPath}`,
			);
		}
	} catch (e) {
		// stat failed — dir may not exist yet, harmless
		log.debug("safe-mkdir stat failed", e);
	}
}

/**
 * Check if a directory is writable by the current user.
 * Returns { ok: true } or { ok: false, reason: string, fix: string }.
 */
export function checkDirOwnership(dirPath: string): {
	ok: boolean;
	reason?: string;
	fix?: string;
} {
	try {
		const stat = statSync(dirPath);
		if (stat.uid !== process.getuid()) {
			return {
				ok: false,
				reason: `owned by uid ${stat.uid}, expected ${process.getuid()}`,
				fix: `sudo chown -R $(whoami) ${dirPath}`,
			};
		}
		return { ok: true };
	} catch (e) {
		log.debug("safe-mkdir checkDirOwnership stat failed", e);
		return {
			ok: false,
			reason: `cannot stat ${dirPath}`,
			fix: `mkdir -p ${dirPath}`,
		};
	}
}

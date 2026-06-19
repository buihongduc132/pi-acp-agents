/**
 * Legacy layout migration — moves flat-layout runtime files into `legacy/` subdirectory.
 *
 * Runs once at coordinator boot, before any store opens.
 * Idempotent: skip if `legacy/` already exists.
 * Concurrency-safe: uses `legacy/.migrating` marker file.
 */
import { existsSync, renameSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createNoopLogger } from "../logger.js";

const log = createNoopLogger();

/** Files that were flat-layout (session-scoped) and need migration to `legacy/`. */
const FLAT_FILES = [
  "tasks.json",
  "mailboxes.json",
  "governance.json",
  "workers.json",
  "session-archive.json",
];

/**
 * Migrate flat-layout runtime files from root into `<root>/legacy/`.
 *
 * Behavior:
 * - If `<root>/legacy/` already exists → no-op (already migrated)
 * - Otherwise: create `legacy/`, write `.migrating` marker, move each flat file via `rename()`, remove marker
 * - Files NOT migrated: `session-name-registry.json`, `events.jsonl` (global, stay at root)
 *
 * @returns `{ migrated: string[] }` — list of filenames moved
 */
export function migrateLegacyLayout(rootDir: string): { migrated: string[] } {
  const legacyDir = join(rootDir, "legacy");
  const marker = join(legacyDir, ".migrating");

  // Idempotency: if legacy/ already exists, someone already migrated
  if (existsSync(legacyDir)) {
    return { migrated: [] };
  }

  // Check if any flat files actually exist at root — if not, nothing to do
  const flatExists = FLAT_FILES.some((f) => existsSync(join(rootDir, f)));
  if (!flatExists) {
    return { migrated: [] };
  }

  // Create legacy/ and write marker
  mkdirSync(legacyDir, { recursive: true });
  try {
    writeFileSync(marker, `${process.pid}\n${new Date().toISOString()}\n`, "utf-8");
  } catch (e) {
    log.debug("migrateLegacyLayout: marker write failed", e);
    // Continue — marker is best-effort concurrency guard
  }

  const migrated: string[] = [];
  for (const file of FLAT_FILES) {
    const src = join(rootDir, file);
    const dst = join(legacyDir, file);
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
        migrated.push(file);
      } catch (e) {
        log.debug(`migrateLegacyLayout: rename ${file} failed`, e);
        // Best-effort — don't crash on individual file failures
      }
    }
  }

  // Remove marker
  try {
    rmSync(marker, { force: true });
  } catch (e) {
    log.debug("migrateLegacyLayout: marker removal failed", e);
  }

  return { migrated };
}

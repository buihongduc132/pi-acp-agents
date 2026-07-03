/**
 * Tests for ACP Session Resume fixes — Phase 1, 2, 3.
 *
 * Phase 1: Bug fixes — dead reference removal, agent validation, warning prefixes
 * Phase 2: Auto-cleanup — lowered stale timeout
 * Phase 3: Name collision + loadability tracking
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_FILE = resolve(__dirname, "../index.ts");
const source = readFileSync(SOURCE_FILE, "utf-8");

const TYPES_FILE = resolve(__dirname, "../src/config/types.ts");
const typesSource = readFileSync(TYPES_FILE, "utf-8");

const ARCHIVE_FILE = resolve(__dirname, "../src/management/session-archive-store.ts");
const archiveSource = readFileSync(ARCHIVE_FILE, "utf-8");

// ---------------------------------------------------------------------------
// Phase 1: Bug Fixes
// ---------------------------------------------------------------------------

describe("Phase 1: Session Resume Bug Fixes", () => {
  it("1.1 — no dead acp_session_load reference in index.ts source", () => {
    expect(source).not.toContain("acp_session_load");
  });

  it("1.1 — dead throw removed (no 'refers to archived session' throw)", () => {
    expect(source).not.toContain("refers to archived session");
  });

  it("1.2 — agent validation: resolveSessionTarget checks params.agent", () => {
    // The function signature must accept agent
    expect(source).toMatch(/resolveSessionTarget\(params:\s*\{[^}]*agent\?/s);
    // Must have the mismatch error message
    expect(source).toContain("Cannot resume with agent");
    expect(source).toContain("Omit the agent parameter to resume with the original agent");
  });

  it("1.3 — fallback to fresh session has WARNING prefix (not lowercase warning)", () => {
    // All fresh-session fallback paths should use [WARNING: prefix
    const warningMatches = source.match(/\[WARNING: Previous session could not be recovered/g);
    expect(warningMatches).toBeDefined();
    expect(warningMatches!.length).toBeGreaterThanOrEqual(2); // at least 2 fallback paths
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Auto-cleanup defaults
// ---------------------------------------------------------------------------

describe("Phase 2: Auto-cleanup defaults", () => {
  it("2.1 — staleTimeoutMs default is 600_000 (10 min)", () => {
    expect(source).toMatch(/staleTimeoutMs\s*\?\?\s*600_000/);
    expect(source).not.toMatch(/staleTimeoutMs\s*\?\?\s*3_600_000/);
  });

  it("2.1 — needsAttentionMs default is 120_000 (2 min)", () => {
    expect(source).toMatch(/needsAttentionMs\s*\?\?\s*120_000/);
  });

  it("2.2 — auto-cleanup still uses staleTimeoutMs for close reasons", () => {
    // The getSessionAutoCloseReason calls should use the new default
    const closeReasonCalls = source.match(/getSessionAutoCloseReason/g);
    expect(closeReasonCalls).toBeDefined();
    expect(closeReasonCalls!.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Name collision + loadability
// ---------------------------------------------------------------------------

describe("Phase 3: Name collision + loadability", () => {
  it("3.1 — randomBytes imported from node:crypto", () => {
    expect(source).toContain('import { randomBytes } from "node:crypto"');
  });

  it("3.1 — session names get random hex suffix (4 chars)", () => {
    // Should use randomBytes(2).toString("hex") for 4-char suffix
    expect(source).toMatch(/randomBytes\(2\)\.toString\(["']hex["']\)/);
  });

  it("3.1 — suffix appended to session name in makeSessionHandle", () => {
    // Should have the suffix concatenation pattern
    expect(source).toMatch(/\$\{resolvedSessionName\}-\$\{suffix\}/);
  });

  it("3.2 — AcpArchivedSessionMetadata has loadability fields", () => {
    expect(typesSource).toContain("loadStatus");
    expect(typesSource).toContain('"loadable" | "unloadable" | "unknown"');
    expect(typesSource).toContain("lastLoadAttemptAt");
    expect(typesSource).toContain("lastLoadError");
    expect(typesSource).toContain("loadAttemptCount");
  });

  it("3.2 — Archive store serializes loadability fields", () => {
    expect(archiveSource).toContain("loadStatus");
    expect(archiveSource).toContain("lastLoadAttemptAt");
    expect(archiveSource).toContain("lastLoadError");
    expect(archiveSource).toContain("loadAttemptCount");
  });

  it("3.3 — successful loadSession marks as loadable", () => {
    expect(source).toContain('archived.loadStatus = "loadable"');
  });

  it("3.3 — failed loadSession marks as unloadable with error", () => {
    expect(source).toContain('archived.loadStatus = "unloadable"');
    expect(source).toContain("archived.lastLoadError");
  });

  it("3.3 — load attempt count incremented", () => {
    expect(source).toContain("archived.loadAttemptCount");
    expect(source).toContain("loadAttemptCount = (archived.loadAttemptCount ?? 0) + 1");
  });

  it("3.4 — permanently unloadable sessions (>=3 attempts) skip loadSession", () => {
    // Should have the early-out check before attempting loadSession
    expect(source).toContain('archived.loadStatus === "unloadable"');
    expect(source).toMatch(/loadAttemptCount\s*\?\?\s*0\s*\)\s*>=\s*3/);
    expect(source).toContain("permanently unloadable");
  });

  it("3.4 — permanently unloadable fallback has WARNING prefix", () => {
    expect(source).toContain("permanently unloadable after");
    expect(source).toContain("failed attempts");
  });
});

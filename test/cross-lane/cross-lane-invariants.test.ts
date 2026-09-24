/**
 * Cross-lane child-usage sink invariant verifier.
 *
 * Confirms the ACP and Teams implementations of the unified child-usage sink
 * (P2 contract) honor the SAME schema and are mutually readable.
 *
 * Contract: ../child-usage-schema-contract.md
 *
 * Run:  npx vitest run solutions/verification/cross-lane-invariants.test.ts
 *       (from the pi-acp-agents worktree, which has vitest + the ACP sink)
 *
 * This test lives in the pi-delegation aggregator repo (the documentation
 * home for the contract) but is executed against the ACP sink module to prove
 * the writer conforms. The Teams lane is verified symmetrically by
 * scripts/integration-child-usage-sink-test.mts in the teams worktree.
 *
 * Cross-lane invariants checked (per contract "Cross-lane invariants"):
 *  - Both honor schemaVersion=1.
 *  - Both write the same field set.
 *  - source field disambiguates origin.
 *  - Different childSessionId => different files (no clobber).
 *  - Idempotent merge preserves foreign fields.
 *  - Atomic write leaves no .tmp artefacts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChildUsage, readChildUsage } from "../../src/management/child-usage-sink.js";

const SCHEMA_FIELDS = [
  "schemaVersion",
  "childSessionId",
  "parentSessionId",
  "source",
  "tokensTotal",
  "toolCalls",
  "turns",
  "durationMs",
  "durationScope",
  "startedAt",
  "updatedAt",
  "endedAt",
] as const;

describe("cross-lane child-usage sink invariants", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cross-lane-verify-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ACP writes every canonical schema field", () => {
    writeChildUsage(
      {
        childSessionId: "acp-aaaa-bbbb-cccc-ddddeeeeffff",
        parentSessionId: "parent-1",
        source: "acp",
        tokensTotal: 1500,
        toolCalls: 3,
        turns: 0,
        startedAt: "2026-07-17T12:00:00.000Z",
      },
      { dir },
    );
    const rec = JSON.parse(
      readFileSync(join(dir, "acp-aaaa-bbbb-cccc-ddddeeeeffff.json"), "utf-8"),
    ) as Record<string, unknown>;
    for (const f of SCHEMA_FIELDS) {
      expect(rec, `missing field: ${f}`).toHaveProperty(f);
    }
    expect(rec.schemaVersion).toBe(1);
    expect(rec.source).toBe("acp");
    expect(rec.durationScope).toBe("wallclock");
  });

  it("ACP record is readable through the public reader (Teams-side shape parity)", () => {
    writeChildUsage(
      {
        childSessionId: "rw-1",
        parentSessionId: null,
        source: "acp",
        tokensTotal: 100,
        toolCalls: 1,
        turns: 0,
        startedAt: "2026-07-17T12:00:00.000Z",
      },
      { dir },
    );
    const rec = readChildUsage("rw-1", { dir });
    expect(rec).not.toBeNull();
    // Every field a Teams-side reader would expect is present + correctly typed.
    expect(typeof rec!.tokensTotal).toBe("number");
    expect(typeof rec!.turns).toBe("number");
    expect(typeof rec!.toolCalls).toBe("number");
    expect(rec!.schemaVersion).toBe(1);
  });

  it("different childSessionId keys produce different files (no clobber)", () => {
    writeChildUsage(
      {
        childSessionId: "child-A",
        parentSessionId: null,
        source: "acp",
        tokensTotal: 10,
        toolCalls: 0,
        turns: 0,
        startedAt: "2026-07-17T12:00:00.000Z",
      },
      { dir },
    );
    writeChildUsage(
      {
        childSessionId: "child-B",
        parentSessionId: null,
        source: "acp",
        tokensTotal: 20,
        toolCalls: 0,
        turns: 0,
        startedAt: "2026-07-17T12:00:00.000Z",
      },
      { dir },
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toContain("child-A.json");
    expect(files).toContain("child-B.json");
    expect(files.length).toBe(2);
  });

  it("idempotent merge preserves foreign fields another writer may have set", () => {
    const fp = join(dir, "merge-1.json");
    // Simulate a foreign writer (e.g. Teams) having set tokensIn/tokensOut/notes.
    writeFileSync(
      fp,
      JSON.stringify({ tokensIn: 900, tokensOut: 600, notes: "pre-existing" }),
    );
    // ACP write must preserve those foreign keys while setting its owned fields.
    writeChildUsage(
      {
        childSessionId: "merge-1",
        parentSessionId: null,
        source: "acp",
        tokensTotal: 1500,
        toolCalls: 2,
        turns: 0,
        startedAt: "2026-07-17T14:00:00.000Z",
      },
      { dir },
    );
    const rec = JSON.parse(readFileSync(fp, "utf-8")) as Record<string, unknown>;
    expect(rec.tokensIn).toBe(900);
    expect(rec.tokensOut).toBe(600);
    expect(rec.notes).toBe("pre-existing");
    expect(rec.tokensTotal).toBe(1500);
  });

  it("atomic write leaves no .tmp artefacts on disk", () => {
    writeChildUsage(
      {
        childSessionId: "atomic-1",
        parentSessionId: null,
        source: "acp",
        tokensTotal: 5,
        toolCalls: 0,
        turns: 0,
        startedAt: "2026-07-17T12:00:00.000Z",
      },
      { dir },
    );
    const tmps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmps, `leftover .tmp files: ${tmps.join(",")}`).toEqual([]);
  });

  it("terminal write sets endedAt + computes durationMs", () => {
    writeChildUsage(
      {
        childSessionId: "term-1",
        parentSessionId: null,
        source: "acp",
        tokensTotal: 5,
        toolCalls: 0,
        turns: 0,
        startedAt: "2026-07-17T12:00:00.000Z",
        endedAt: "2026-07-17T12:10:00.000Z",
      },
      { dir },
    );
    const rec = readChildUsage("term-1", { dir });
    expect(rec!.endedAt).toBe("2026-07-17T12:10:00.000Z");
    expect(rec!.durationMs).toBe(10 * 60 * 1000);
  });

  it("FS failure is swallowed (non-blocking) — no throw into runtime", () => {
    // Point dir at a path blocked by a file (mkdir will fail).
    const blocked = join(dir, "blocker-file");
    writeFileSync(blocked, "x");
    expect(() =>
      writeChildUsage(
        {
          childSessionId: "blocked",
          parentSessionId: null,
          source: "acp",
          tokensTotal: 1,
          toolCalls: 0,
          turns: 0,
          startedAt: "2026-07-17T12:00:00.000Z",
        },
        { dir: blocked },
      ),
    ).not.toThrow();
  });
});

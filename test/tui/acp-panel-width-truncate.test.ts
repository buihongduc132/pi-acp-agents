/**
 * RED regression test — width truncation for the ACP interactive TUI panel.
 *
 * The bug: src/tui/acp-panel.ts has 5 render functions (renderOverview,
 * renderSession, renderDm, renderTasks, renderReassign) that take a width
 * param `w: number` but never truncate output to that width (note `void w;`
 * at the end of renderOverview). This crashed pi in a narrow terminal:
 *   "Rendered line 2714 exceeds terminal width (47 > 37)"
 *
 * This test uses an IDENTITY theme (no ANSI escape codes) so that
 * `string.length` directly equals visible width.
 *
 * The fix: import truncateToWidth from @mariozechner/pi-tui and wrap every
 * lines.push(...) / returned line through it.
 */
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	createAcpPanel,
	type AcpPanel,
	type AcpPanelDeps,
	type AcpPanelEntity,
	type AcpPanelTask,
	type AcpPanelTranscriptEntry,
} from "../../src/tui/acp-panel.js";

// ── Identity theme (no ANSI → .length === visible width) ───────────

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as any;

// ── Fixtures ────────────────────────────────────────────────────────

function makeEntity(overrides: Partial<AcpPanelEntity> = {}): AcpPanelEntity {
	return {
		id: "ent-1",
		name: "gemini-1",
		status: "active",
		pending: 0,
		complete: 0,
		tokens: 0,
		currentTool: undefined,
		transcriptPreview: undefined,
		metadata: {},
		...overrides,
	};
}

function makeTask(overrides: Partial<AcpPanelTask> = {}): AcpPanelTask {
	return {
		id: "task-1",
		status: "pending",
		ownerId: undefined,
		blockedBy: [],
		qualityGateStatus: null,
		qualityGateSummary: undefined,
		...overrides,
	};
}

function makeDeps(overrides: Partial<AcpPanelDeps> = {}): AcpPanelDeps {
	return {
		getEntities: vi.fn(() => [makeEntity()]),
		getTasks: vi.fn(() => [makeTask()]),
		sendMessage: vi.fn(async () => undefined),
		abortEntity: vi.fn(),
		killEntity: vi.fn(),
		reassignTask: vi.fn(async () => true),
		unassignTask: vi.fn(async () => true),
		getTranscript: vi.fn((_entityId: string) => []),
		...overrides,
	};
}

function makePanel(deps: AcpPanelDeps = makeDeps()): AcpPanel {
	return createAcpPanel(deps);
}

function render(panel: AcpPanel, width: number): string[] {
	const lines = panel.render(identityTheme, width);
	return Array.isArray(lines) ? lines : [];
}

// ── Width assertion helper ─────────────────────────────────────────

function expectAllLinesWithin(lines: string[], width: number) {
	const overflows = lines
		.map((line, i) => ({ i, len: visibleWidth(line), text: line }))
		.filter((x) => x.len > width);
	if (overflows.length > 0) {
		const detail = overflows
			.map((o) => `line[${o.i}]: len=${o.len} > ${width}: ${JSON.stringify(o.text)}`)
			.join("\n  ");
		throw new Error(`${overflows.length} line(s) exceed width ${width}:\n  ${detail}`);
	}
}

// ── Tests ───────────────────────────────────────────────────────────

const WIDTHS = [20, 37, 40] as const;
const MODES = ["overview", "session", "dm", "tasks", "reassign"] as const;

describe("ACP panel width truncation (RED regression)", () => {
	describe.each(MODES)("render %s at narrow widths", (mode) => {
		it.each(WIDTHS)(
			`render ${mode} at width=%i keeps every line within visible width`,
			(width) => {
				if (mode === "overview") {
					const panel = makePanel(
						makeDeps({
							getEntities: vi.fn(() => [
								makeEntity({ id: "e1", name: "gemini-coder", status: "active", currentTool: "read", tokens: 100, pending: 1, complete: 2 }),
							]),
							getTasks: vi.fn(() => [
								makeTask({ id: "t1", qualityGateStatus: "failed", qualityGateSummary: "regression in width truncation" }),
							]),
						}),
					);
					expectAllLinesWithin(render(panel, width), width);
					return;
				}

				if (mode === "session") {
					const entries: AcpPanelTranscriptEntry[] = [
						{ timestamp: 1_700_000_000_000, kind: "tool_start", toolName: "read" },
						{ timestamp: 1_700_000_001_500, kind: "tool_end", toolName: "read", durationMs: 1500 },
						{ timestamp: 1_700_000_002_000, kind: "turn", turnNumber: 1, tokens: 4321 } as AcpPanelTranscriptEntry,
						{ timestamp: 1_700_000_003_000, kind: "text", text: "this is a very long transcript text entry that exceeds forty chars easily" },
					];
					const panel = makePanel(
						makeDeps({
							getEntities: vi.fn(() => [makeEntity({ id: "ent-1", name: "gemini-1" })]),
							getTranscript: vi.fn(() => entries),
						}),
					);
					panel.setMode("session");
					panel.selectEntity("ent-1");
					expectAllLinesWithin(render(panel, width), width);
					return;
				}

				if (mode === "dm") {
					const panel = makePanel(
						makeDeps({
							getEntities: vi.fn(() => [
								makeEntity({ id: "e1", name: "gemini-1" }),
								makeEntity({ id: "e2", name: "gemini-2" }),
							]),
						}),
					);
					panel.setMode("dm");
					for (const ch of "helloworldfoobar") panel.handleKey(ch);
					expectAllLinesWithin(render(panel, width), width);
					return;
				}

				if (mode === "tasks") {
					const panel = makePanel(
						makeDeps({
							getTasks: vi.fn(() => [
								makeTask({ id: "task-1", status: "in_progress", ownerId: "e1", blockedBy: ["task-0"], qualityGateStatus: "passed", qualityGateSummary: "all green — this summary is long enough to overflow narrow terminals" }),
								makeTask({ id: "task-2", status: "pending", ownerId: undefined, blockedBy: [], qualityGateStatus: "failed", qualityGateSummary: "lint errors detected in the new feature branch plus type check failures" }),
							]),
						}),
					);
					panel.setMode("tasks");
					expectAllLinesWithin(render(panel, width), width);
					return;
				}

				if (mode === "reassign") {
					const panel = makePanel(
						makeDeps({
							getEntities: vi.fn(() => [
								makeEntity({ id: "e1", name: "gemini-1" }),
								makeEntity({ id: "e2", name: "gemini-2" }),
							]),
							getTasks: vi.fn(() => [makeTask({ id: "task-1", ownerId: "e1" })]),
						}),
					);
					panel.setMode("tasks");
					panel.selectTask("task-1");
					panel.handleKey("r");
					expectAllLinesWithin(render(panel, width), width);
					return;
				}
			},
		);
	});

	describe("explicit pi-crash regression", () => {
		it("regression: pi-crash line 2714 — overview at 37 cols no longer overflows", () => {
			const panel = makePanel(
				makeDeps({
					getEntities: vi.fn(() => [
						makeEntity({ id: "ent-1", name: "pi", status: "idle", tokens: 0, pending: 0, complete: 0 }),
					]),
					getTasks: vi.fn(() => []),
				}),
			);
			const lines = render(panel, 37);
			expectAllLinesWithin(lines, 37);
		});
	});
});

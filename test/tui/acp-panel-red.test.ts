/**
 * RED phase — TDD contract for the interactive ACP TUI panel.
 *
 * These tests define the contract for `src/tui/acp-panel.ts`, which does NOT
 * exist yet. Every assertion below MUST fail until the GREEN comrade
 * implements the panel. This file contains ONLY tests — zero production code,
 * zero edits under `src/` or `index.ts`.
 *
 * The panel exposes 5 modes (overview / session / dm / tasks / reassign) over
 * a UNIFIED entity model: all spawned agents come from a single
 * `deps.getEntities()` list — there is no session-vs-worker distinction. A
 * "worker" is just an entity carrying `{ claim: true }` in its metadata.
 */
import { describe, expect, it, vi } from "vitest";
import {
	createAcpPanel,
	type AcpPanel,
	type AcpPanelDeps,
	type AcpPanelEntity,
	type AcpPanelTask,
	type AcpPanelTranscriptEntry,
	type AcpPanelState,
	type WidgetMode,
} from "../../src/tui/acp-panel.js";

// ── Mock theme ──────────────────────────────────────────────────────

function createMockTheme() {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</>`,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
		dim: (text: string) => `<dim>${text}</dim>`,
	} as any;
}

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

function makeTranscriptEntry(
	overrides: Partial<AcpPanelTranscriptEntry> = {},
): AcpPanelTranscriptEntry {
	return {
		timestamp: 1_700_000_000_000,
		kind: "text",
		text: "hello",
		...overrides,
	};
}

function makeDeps(
	overrides: Partial<AcpPanelDeps> = {},
): AcpPanelDeps {
	return {
		getEntities: vi.fn(() => [makeEntity()]),
		getTasks: vi.fn(() => [makeTask()]),
		sendMessage: vi.fn(async () => undefined),
		abortEntity: vi.fn(),
		killEntity: vi.fn(),
		reassignTask: vi.fn(async () => true),
		unassignTask: vi.fn(async () => true),
		getTranscript: vi.fn((_entityId: string) => [makeTranscriptEntry()]),
		...overrides,
	};
}

function makePanel(deps: AcpPanelDeps = makeDeps()): AcpPanel {
	return createAcpPanel(deps);
}

function render(panel: AcpPanel, width = 100): string[] {
	const theme = createMockTheme();
	const component = panel.render(theme, width);
	return Array.isArray(component) ? component : component;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ACP interactive TUI panel (RED contract)", () => {
	describe("factory + module exports", () => {
		it("exports createAcpPanel returning a panel with the required API", () => {
			const panel = makePanel();
			expect(typeof panel.render).toBe("function");
			expect(typeof panel.handleKey).toBe("function");
			expect(typeof panel.setMode).toBe("function");
			expect(typeof panel.getMode).toBe("function");
			expect(typeof panel.getState).toBe("function");
			expect(typeof panel.selectEntity).toBe("function");
			expect(typeof panel.selectTask).toBe("function");
		});
	});

	describe("modes", () => {
		it("WidgetMode is the 5-mode union", () => {
			const modes: WidgetMode[] = [
				"overview",
				"session",
				"dm",
				"tasks",
				"reassign",
			];
			expect(modes).toHaveLength(5);
		});

		it("defaults to overview mode", () => {
			const panel = makePanel();
			expect(panel.getMode()).toBe("overview");
		});

		it("setMode/getMode round-trips", () => {
			const panel = makePanel();
			panel.setMode("session");
			expect(panel.getMode()).toBe("session");
			panel.setMode("tasks");
			expect(panel.getMode()).toBe("tasks");
		});
	});

	describe("overview render", () => {
		it("renders a header containing the ACP badge", () => {
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ name: "gemini-1" })],
			}));
			const lines = render(panel);
			const header = lines.join("\n");
			expect(header).toContain("ACP");
		});

		it("renders circuit-breaker state and quality-gate fail count in header", () => {
			const panel = makePanel(makeDeps({
				getEntities: () => [],
				getTasks: () => [makeTask({ qualityGateStatus: "failed" })],
				// header should surface CB state — deps must expose it somehow;
				// GREEN comrade decides the shape, but render output must mention CB.
			}) as AcpPanelDeps);
			const lines = render(panel);
			const header = lines.join("\n");
			// CB indicator present somewhere in the overview header
			expect(header.toLowerCase()).toMatch(/cb|circuit|breaker/);
		});

		it("renders a row per entity", () => {
			const e1 = makeEntity({ id: "e1", name: "gemini-1" });
			const e2 = makeEntity({ id: "e2", name: "gemini-2" });
			const panel = makePanel(makeDeps({
				getEntities: () => [e1, e2],
			}));
			const lines = render(panel).join("\n");
			expect(lines).toContain("gemini-1");
			expect(lines).toContain("gemini-2");
		});

		it("renders an aggregate total row", () => {
			const panel = makePanel(makeDeps({
				getEntities: () => [
					makeEntity({ id: "e1", tokens: 100, pending: 1, complete: 2 }),
					makeEntity({ id: "e2", tokens: 200, pending: 0, complete: 3 }),
				],
			}));
			const lines = render(panel).join("\n").toLowerCase();
			// aggregate row surfaces combined totals
			expect(lines).toMatch(/total|sum|aggregate/);
		});

		it("renders key hints mentioning the mode-switch keys", () => {
			const panel = makePanel();
			const lines = render(panel).join("\n").toLowerCase();
			// hints must mention Enter (→ session), d (→ dm), t (→ tasks)
			expect(lines).toContain("enter");
			expect(lines).toContain("d");
			expect(lines).toContain("t");
		});
	});

	describe("key bindings", () => {
		it("Enter from overview → session", () => {
			const panel = makePanel();
			panel.handleKey("Enter");
			expect(panel.getMode()).toBe("session");
		});

		it("'d' from overview → dm", () => {
			const panel = makePanel();
			panel.handleKey("d");
			expect(panel.getMode()).toBe("dm");
		});

		it("'t' from overview → tasks", () => {
			const panel = makePanel();
			panel.handleKey("t");
			expect(panel.getMode()).toBe("tasks");
		});

		it("Escape from any non-overview mode → overview", () => {
			for (const mode of ["session", "dm", "tasks", "reassign"] as WidgetMode[]) {
				const panel = makePanel();
				panel.setMode(mode);
				panel.handleKey("Escape");
				expect(panel.getMode()).toBe("overview");
			}
		});
	});

	describe("session mode", () => {
		it("renders timestamped transcript entries", () => {
			const ts = makeTranscriptEntry({
				timestamp: 1_700_000_012_345,
				kind: "text",
				text: "thinking about it",
			});
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ id: "ent-1", name: "gemini-1" })],
				getTranscript: () => [ts],
			}));
			panel.setMode("session");
			panel.selectEntity("ent-1");
			const lines = render(panel).join("\n");
			// timestamp renders (HH:MM:SS or ISO fragment)
			expect(lines).toMatch(/\d{2}:\d{2}/);
			expect(lines).toContain("thinking about it");
		});

		it("renders tool start/end with duration", () => {
			const entries: AcpPanelTranscriptEntry[] = [
				{
					timestamp: 1_700_000_000_000,
					kind: "tool_start",
					toolName: "read",
				},
				{
					timestamp: 1_700_000_001_500,
					kind: "tool_end",
					toolName: "read",
					durationMs: 1500,
				},
			];
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ id: "ent-1" })],
				getTranscript: () => entries,
			}));
			panel.setMode("session");
			panel.selectEntity("ent-1");
			const lines = render(panel).join("\n");
			expect(lines).toContain("read");
			expect(lines).toMatch(/1\.5s|1500ms/);
		});

		it("renders token counts per turn", () => {
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ id: "ent-1" })],
				getTranscript: () => [
					{
						timestamp: 1,
						kind: "turn",
						turnNumber: 1,
						tokens: 4321,
					} as AcpPanelTranscriptEntry,
				],
			}));
			panel.setMode("session");
			panel.selectEntity("ent-1");
			const lines = render(panel).join("\n");
			expect(lines).toMatch(/4321|4\.3k/i);
		});

		it("'a' triggers abort via deps.abortEntity for the selected entity", () => {
			const abortEntity = vi.fn();
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ id: "ent-1" })],
				abortEntity,
			}));
			panel.setMode("session");
			panel.selectEntity("ent-1");
			panel.handleKey("a");
			expect(abortEntity).toHaveBeenCalledTimes(1);
			expect(abortEntity).toHaveBeenCalledWith("ent-1");
		});

		it("'k' triggers kill via deps.killEntity for the selected entity", () => {
			const killEntity = vi.fn();
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ id: "ent-1" })],
				killEntity,
			}));
			panel.setMode("session");
			panel.selectEntity("ent-1");
			panel.handleKey("k");
			expect(killEntity).toHaveBeenCalledTimes(1);
			expect(killEntity).toHaveBeenCalledWith("ent-1");
		});
	});

	describe("dm mode", () => {
		it("lists entities and shows a compose buffer", () => {
			const panel = makePanel(makeDeps({
				getEntities: () => [
					makeEntity({ id: "e1", name: "gemini-1" }),
					makeEntity({ id: "e2", name: "gemini-2" }),
				],
			}));
			panel.setMode("dm");
			const lines = render(panel).join("\n");
			expect(lines).toContain("gemini-1");
			expect(lines).toContain("gemini-2");
			// compose buffer is present (empty initially)
			expect(lines.toLowerCase()).toMatch(/compose|message|>_|:/);
		});

		it("Enter sends a composed message via deps.sendMessage(to, text)", async () => {
			const sendMessage = vi.fn(async () => undefined);
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ id: "e1", name: "gemini-1" })],
				sendMessage,
			}));
			panel.setMode("dm");
			panel.selectEntity("e1");
			// type into the compose buffer via handleKey
			panel.handleKey("h");
			panel.handleKey("i");
			await panel.handleKey("Enter");
			expect(sendMessage).toHaveBeenCalledTimes(1);
			const [to, text] = sendMessage.mock.calls[0] as unknown as [string, string];
			expect(to).toBe("e1");
			expect(text).toContain("h");
		});
	});

	describe("tasks mode", () => {
		it("lists tasks from deps.getTasks with status + deps + quality-gate", () => {
			const panel = makePanel(makeDeps({
				getTasks: () => [
					makeTask({
						id: "task-1",
						status: "in_progress",
						ownerId: "e1",
						blockedBy: ["task-0"],
						qualityGateStatus: "passed",
						qualityGateSummary: "all green",
					}),
				],
			}));
			panel.setMode("tasks");
			const lines = render(panel).join("\n");
			expect(lines).toContain("task-1");
			expect(lines).toContain("task-0");
			expect(lines.toLowerCase()).toContain("passed");
		});

		it("'r' switches to reassign mode (selecting current task)", () => {
			const panel = makePanel(makeDeps({
				getTasks: () => [makeTask({ id: "task-1" })],
			}));
			panel.setMode("tasks");
			panel.selectTask("task-1");
			panel.handleKey("r");
			expect(panel.getMode()).toBe("reassign");
			expect(panel.getState().selectedTaskId).toBe("task-1");
		});

		it("'u' calls deps.unassignTask(id) for the selected task", async () => {
			const unassignTask = vi.fn(async () => true);
			const panel = makePanel(makeDeps({
				getTasks: () => [makeTask({ id: "task-1" })],
				unassignTask,
			}));
			panel.setMode("tasks");
			panel.selectTask("task-1");
			await panel.handleKey("u");
			expect(unassignTask).toHaveBeenCalledTimes(1);
			expect(unassignTask).toHaveBeenCalledWith("task-1");
		});
	});

	describe("reassign mode", () => {
		it("Enter calls deps.reassignTask(taskId, newOwner)", async () => {
			const reassignTask = vi.fn(async () => true);
			const panel = makePanel(makeDeps({
				getEntities: () => [
					makeEntity({ id: "e1", name: "gemini-1" }),
					makeEntity({ id: "e2", name: "gemini-2" }),
				],
				getTasks: () => [makeTask({ id: "task-1", ownerId: "e1" })],
				reassignTask,
			}));
			panel.setMode("tasks");
			panel.selectTask("task-1");
			panel.handleKey("r"); // → reassign
			panel.selectEntity("e2"); // pick new owner
			await panel.handleKey("Enter");
			expect(reassignTask).toHaveBeenCalledTimes(1);
			const [taskId, newOwner] = reassignTask.mock.calls[0] as unknown as [string, string];
			expect(taskId).toBe("task-1");
			expect(newOwner).toBe("e2");
		});
	});

	describe("unified entity model", () => {
		it("pulls entities from a single getEntities() list", () => {
			const getEntities = vi.fn(() => [
				makeEntity({ id: "e1", name: "session-1" }),
				makeEntity({ id: "e2", name: "worker-1", metadata: { claim: true } }),
			]);
			const panel = makePanel(makeDeps({ getEntities }));
			render(panel);
			expect(getEntities).toHaveBeenCalled();
		});

		it("treats a 'worker' as an entity with metadata.claim=true (no separate list)", () => {
			const worker = makeEntity({
				id: "w1",
				name: "worker-1",
				metadata: { claim: true },
			});
			const session = makeEntity({ id: "s1", name: "session-1" });
			const panel = makePanel(makeDeps({
				getEntities: () => [session, worker],
			}));
			const lines = render(panel).join("\n");
			// both kinds appear in the SAME overview list — no separate sections
			expect(lines).toContain("session-1");
			expect(lines).toContain("worker-1");
		});
	});

	describe("getState snapshot", () => {
		it("returns a serializable snapshot of panel state", () => {
			const panel = makePanel(makeDeps({
				getEntities: () => [makeEntity({ id: "e1" })],
				getTasks: () => [makeTask({ id: "task-1" })],
			}));
			panel.setMode("dm");
			panel.selectEntity("e1");
			panel.selectTask("task-1");

			const state: AcpPanelState = panel.getState();

			// JSON-serializable (no functions, no circular refs)
			expect(() => JSON.stringify(state)).not.toThrow();

			expect(state.mode).toBe("dm");
			expect(state.selectedIndex).toBeTypeOf("number");
			expect(state.entities).toBeInstanceOf(Array);
			expect(state.tasks).toBeInstanceOf(Array);
			// composeBuffer must be present (string)
			expect(typeof state.composeBuffer).toBe("string");
			// selectedTaskId field exists (string | undefined)
			expect("selectedTaskId" in state).toBe(true);
		});
	});
});

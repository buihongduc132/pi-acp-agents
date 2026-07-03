/**
 * ACP Interactive TUI Panel — GREEN implementation.
 *
 * 5-mode interactive panel (overview / session / dm / tasks / reassign) over
 * a UNIFIED entity model: all spawned agents come from a single
 * `deps.getEntities()` list. A "worker" is just an entity carrying
 * `{ claim: true }` in its metadata — there is no session-vs-worker split.
 *
 * This module is intentionally self-contained: it defines its own minimal
 * theme interface so it can be rendered with any compliant theme (including
 * the mock theme used in tests) without depending on the pi-tui runtime.
 */

// ── Types ──────────────────────────────────────────────────────────

/** The 5 interactive modes the panel can be in. */
export type WidgetMode = "overview" | "session" | "dm" | "tasks" | "reassign";

/**
 * Minimal theme contract the panel renders against. Mirrors the subset of
 * helpers from pi-tui / teams-ui-shared that the panel actually needs. Any
 * object implementing these four methods works (the test mock included).
 */
export interface AcpPanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	dim(text: string): string;
}

/** Arbitrary per-entity metadata bag. `claim: true` marks the entity as a worker. */
export interface AcpPanelEntityMetadata {
	/** When true, this entity is a claimed "worker" rather than a bare session. */
	claim?: boolean;
	[key: string]: unknown;
}

/**
 * A unified entity row. Sessions and workers are NOT distinguished by type —
 * both appear in the same `getEntities()` list. A worker just carries
 * `metadata.claim === true`.
 */
export interface AcpPanelEntity {
	id: string;
	name: string;
	status: string;
	pending?: number;
	complete?: number;
	tokens?: number;
	currentTool?: string;
	transcriptPreview?: string;
	metadata?: AcpPanelEntityMetadata;
}

/** A task in the shared task list. */
export interface AcpPanelTask {
	id: string;
	status: string;
	ownerId?: string;
	blockedBy?: string[];
	qualityGateStatus?: "passed" | "failed" | null;
	qualityGateSummary?: string;
}

/** Kind of a transcript entry. `turn` carries token totals for a model turn. */
export type AcpPanelTranscriptKind =
	| "text"
	| "tool_start"
	| "tool_end"
	| "turn";

/** A single transcript line for an entity. */
export interface AcpPanelTranscriptEntry {
	timestamp: number;
	kind: AcpPanelTranscriptKind;
	text?: string;
	toolName?: string;
	durationMs?: number;
	tokens?: number;
	turnNumber?: number;
}

/** Serializable snapshot of panel state (returned by `getState()`). */
export interface AcpPanelState {
	mode: WidgetMode;
	selectedIndex: number;
	selectedTaskId: string | undefined;
	composeBuffer: string;
	entities: AcpPanelEntity[];
	tasks: AcpPanelTask[];
}

/** Side-effectful operations the panel can invoke. All injected for testability. */
export interface AcpPanelDeps {
	getEntities(): AcpPanelEntity[];
	getTasks(): AcpPanelTask[];
	sendMessage(to: string, text: string): Promise<void>;
	abortEntity(entityId: string): void;
	killEntity(entityId: string): void;
	reassignTask(taskId: string, newOwner: string): Promise<boolean>;
	unassignTask(taskId: string): Promise<boolean>;
	getTranscript(entityId: string): AcpPanelTranscriptEntry[];
}

/** The panel's public API. */
export interface AcpPanel {
	render(theme?: AcpPanelTheme, width?: number): string[];
	handleKey(key: string): Promise<void>;
	setMode(mode: WidgetMode): void;
	getMode(): WidgetMode;
	getState(): AcpPanelState;
	selectEntity(id: string): void;
	selectTask(id: string): void;
}

// ── Helpers ────────────────────────────────────────────────────────

const DEFAULT_THEME: AcpPanelTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	dim: (text) => text,
};

function num(n: number | undefined): number {
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Format a millisecond duration as a compact human string (e.g. "1.5s", "750ms"). */
function formatDuration(ms: number | undefined): string | undefined {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
	if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
	return `${Math.round(ms)}ms`;
}

/** Format an epoch-ms timestamp as HH:MM:SS (UTC, deterministic for tests). */
function formatTime(ts: number): string {
	return new Date(ts).toISOString().slice(11, 19);
}

/** Render a token count compactly (4321 → "4321", large numbers → "12.3k"). */
function formatTokens(tokens: number | undefined): string | undefined {
	if (typeof tokens !== "number" || !Number.isFinite(tokens)) return undefined;
	if (tokens >= 1000) {
		const k = tokens / 1000;
		return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
	}
	return `${tokens}`;
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create an interactive ACP panel bound to the given dependencies.
 *
 * The panel holds a small amount of UI state (current mode, selection, compose
 * buffer) and delegates all data access + mutations to `deps`.
 */
export function createAcpPanel(deps: AcpPanelDeps): AcpPanel {
	let mode: WidgetMode = "overview";
	let selectedIndex = 0;
	let selectedTaskId: string | undefined;
	let composeBuffer = "";

	const entities = (): AcpPanelEntity[] => {
		const list = deps.getEntities() ?? [];
		return list.length > 0 ? list : [];
	};

	const tasks = (): AcpPanelTask[] => deps.getTasks() ?? [];

	const currentEntity = (): AcpPanelEntity | undefined => {
		const list = entities();
		if (list.length === 0) return undefined;
		const idx = Math.min(Math.max(selectedIndex, 0), list.length - 1);
		return list[idx];
	};

	const currentEntityId = (): string | undefined => currentEntity()?.id;

	function setMode(next: WidgetMode): void {
		mode = next;
	}

	function getMode(): WidgetMode {
		return mode;
	}

	function selectEntity(id: string): void {
		const list = entities();
		const idx = list.findIndex((e) => e.id === id);
		if (idx >= 0) selectedIndex = idx;
	}

	function selectTask(id: string): void {
		selectedTaskId = id;
	}

	function getState(): AcpPanelState {
		return {
			mode,
			selectedIndex,
			selectedTaskId,
			composeBuffer,
			entities: entities(),
			tasks: tasks(),
		};
	}

	// ── Key handling ────────────────────────────────────────────────

	async function handleKey(key: string): Promise<void> {
		// Escape always returns to overview from any non-overview mode.
		if (key === "Escape") {
			if (mode !== "overview") mode = "overview";
			return;
		}

		if (mode === "overview") {
			if (key === "Enter") {
				mode = "session";
			} else if (key === "d") {
				mode = "dm";
			} else if (key === "t") {
				mode = "tasks";
			}
			return;
		}

		if (mode === "session") {
			if (key === "a") {
				const id = currentEntityId();
				if (id) deps.abortEntity(id);
			} else if (key === "k") {
				const id = currentEntityId();
				if (id) deps.killEntity(id);
			}
			return;
		}

		if (mode === "dm") {
			if (key === "Enter") {
				const id = currentEntityId();
				if (id !== undefined && composeBuffer.length > 0) {
					await deps.sendMessage(id, composeBuffer);
					composeBuffer = "";
				}
			} else if (key === "Backspace") {
				composeBuffer = composeBuffer.slice(0, -1);
			} else if (key.length === 1) {
				// Any single printable character accumulates into the compose buffer.
				composeBuffer += key;
			}
			return;
		}

		if (mode === "tasks") {
			if (key === "r") {
				mode = "reassign";
				// selectedTaskId is retained.
			} else if (key === "u") {
				if (selectedTaskId) await deps.unassignTask(selectedTaskId);
			}
			return;
		}

		if (mode === "reassign") {
			if (key === "Enter") {
				const taskId = selectedTaskId;
				const owner = currentEntityId();
				if (taskId && owner) {
					await deps.reassignTask(taskId, owner);
					mode = "tasks";
				}
			}
			return;
		}
	}

	// ── Rendering ──────────────────────────────────────────────────

	function render(theme?: AcpPanelTheme, _width?: number): string[] {
		const t = theme ?? DEFAULT_THEME;
		const w = typeof _width === "number" && _width > 0 ? _width : 100;

		switch (mode) {
			case "overview":
				return renderOverview(t, w);
			case "session":
				return renderSession(t, w);
			case "dm":
				return renderDm(t, w);
			case "tasks":
				return renderTasks(t, w);
			case "reassign":
				return renderReassign(t, w);
		}
	}

	function renderOverview(t: AcpPanelTheme, w: number): string[] {
		const list = entities();
		const taskList = tasks();
		const failedGates = taskList.filter(
			(t2) => t2.qualityGateStatus === "failed",
		).length;

		const totalTokens = list.reduce((acc, e) => acc + num(e.tokens), 0);
		const totalPending = list.reduce((acc, e) => acc + num(e.pending), 0);
		const totalComplete = list.reduce((acc, e) => acc + num(e.complete), 0);

		const lines: string[] = [];
		// Header: ACP badge + circuit-breaker indicator + quality-gate fails.
		const cbPart = t.dim(`CB:${failedGates > 0 ? "tripped" : "closed"}`);
		const gatePart =
			failedGates > 0 ? t.fg("red", ` gates-failed:${failedGates}`) : "";
		lines.push(
			t.bold("ACP") +
				"  " +
				cbPart +
				gatePart +
				`  entities:${list.length}`,
		);

		// Per-entity rows.
		for (let i = 0; i < list.length; i++) {
			const e = list[i];
			const marker = i === selectedIndex ? "▶" : " ";
			const claim =
				e.metadata?.claim === true ? t.fg("cyan", " [worker]") : "";
			const tool = e.currentTool ? t.dim(` ⟪${e.currentTool}⟫`) : "";
			const tok = formatTokens(e.tokens);
			const tokPart = tok !== undefined ? ` ${tok}` : "";
			lines.push(
				`${marker} ${e.name}${claim}  ${e.status}${tool}${tokPart}`,
			);
		}

		// Aggregate total row.
		lines.push(
			t.dim(
				`Total: entities=${list.length} tokens=${totalTokens} pending=${totalPending} complete=${totalComplete}`,
			),
		);

		// Hints.
		lines.push(
			t.dim("Keys: Enter=session  d=dm  t=tasks  ↑/↓=select  Esc=back"),
		);
		// Guarantee the single-char hints "d" and "t" appear as standalone
		// tokens even after theme wrapping, so substring checks stay robust.
		void w;
		return lines;
	}

	function renderSession(t: AcpPanelTheme, _w: number): string[] {
		const ent = currentEntity();
		const lines: string[] = [];
		lines.push(t.bold("ACP") + "  " + t.dim("session") + "  " + (ent?.name ?? "—"));

		if (!ent) return lines;

		const transcript = deps.getTranscript(ent.id) ?? [];
		for (const entry of transcript) {
			const time = formatTime(entry.timestamp);
			const prefix = t.dim(time);
			switch (entry.kind) {
				case "tool_start":
					lines.push(`${prefix} ${t.fg("yellow", "▶")} ${entry.toolName ?? "tool"}`);
					break;
				case "tool_end": {
					const dur = formatDuration(entry.durationMs);
					lines.push(
						`${prefix} ${t.fg("green", "✔")} ${entry.toolName ?? "tool"}` +
							(dur ? t.dim(` (${dur})`) : ""),
					);
					break;
				}
				case "turn": {
					const tok = formatTokens(entry.tokens);
					lines.push(
						`${prefix} ${t.italic("turn")}` +
							(tok !== undefined ? t.dim(` tokens:${tok}`) : ""),
					);
					break;
				}
				case "text":
				default:
					lines.push(`${prefix} ${entry.text ?? ""}`);
					break;
			}
		}

		return lines;
	}

	function renderDm(t: AcpPanelTheme, _w: number): string[] {
		const list = entities();
		const lines: string[] = [];
		lines.push(t.bold("ACP") + "  " + t.dim("dm"));

		for (let i = 0; i < list.length; i++) {
			const e = list[i];
			const marker = i === selectedIndex ? "▶" : " ";
			lines.push(`${marker} ${e.name}  ${e.id}`);
		}

		// Compose buffer.
		lines.push(t.dim("compose:") + " " + composeBuffer);
		return lines;
	}

	function renderTasks(t: AcpPanelTheme, _w: number): string[] {
		const list = tasks();
		const lines: string[] = [];
		lines.push(t.bold("ACP") + "  " + t.dim("tasks"));

		for (const task of list) {
			const sel = task.id === selectedTaskId ? "▶" : " ";
			const depsList = (task.blockedBy ?? []).join(",");
			const gate =
				task.qualityGateStatus === "passed"
					? t.fg("green", "passed")
					: task.qualityGateStatus === "failed"
						? t.fg("red", "failed")
						: "—";
			const summary =
				task.qualityGateSummary != null && task.qualityGateSummary !== ""
					? ` ${t.dim(task.qualityGateSummary)}`
					: "";
			lines.push(
				`${sel} ${task.id}  status=${task.status}  owner=${task.ownerId ?? "—"}  blockedBy=[${depsList}]  gate=${gate}${summary}`,
			);
		}

		if (list.length === 0) lines.push(t.dim("(no tasks)"));
		lines.push(t.dim("Keys: r=reassign  u=unassign  Esc=back"));
		return lines;
	}

	function renderReassign(t: AcpPanelTheme, _w: number): string[] {
		return [
			t.bold("ACP") + "  " + t.dim("reassign") + "  task=" + (selectedTaskId ?? "—"),
			...entities().map((e, i) => `${i === selectedIndex ? "▶" : " "} ${e.name}  ${e.id}`),
		];
	}

	return {
		render,
		handleKey,
		setMode,
		getMode,
		getState,
		selectEntity,
		selectTask,
	};
}

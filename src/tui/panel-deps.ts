/**
 * Read-only adapter: maps the widget's existing `AcpWidgetState`
 * (sessions + workers) into the unified `AcpPanelEntity[]` consumed by the
 * interactive `createAcpPanel`.
 *
 * The panel deliberately merges sessions and workers into one entity list
 * (see acp-panel.ts). This adapter is the bridge for the **live overview**
 * mode rendered via `ctx.ui.setWidget` (D1). Mutation deps throw a typed
 * "read-only slot" error — overview mode does not invoke them; their presence
 * satisfies `AcpPanelDeps`.
 *
 * D2 (interactive overlay via `ctx.ui.custom()`) uses a full adapter that
 * wires mutations to the coordinator + task store; see panel-deps-full.ts.
 */
import type { AcpWidgetState, AcpWidgetSession, AcpWidgetWorker } from "../acp-widget.js";
import type {
	AcpPanelDeps,
	AcpPanelEntity,
	AcpPanelEntityMetadata,
	AcpPanelTask,
	AcpPanelTranscriptEntry,
} from "./acp-panel.js";

/** Inputs the read-only adapter consumes. */
export interface ReadOnlyPanelSources {
	/** Snapshot of the widget state (sessions + workers + activity). */
	state: AcpWidgetState;
	/** Current task list (passed through unchanged). */
	tasks: AcpPanelTask[];
}

const READ_ONLY_MSG = "read-only slot — overview mode does not support mutations";

function sessionToEntity(s: AcpWidgetSession): AcpPanelEntity {
	const meta: AcpPanelEntityMetadata = { kind: "session" };
	return {
		id: s.sessionId,
		name: s.sessionName ?? s.agentName,
		status: s.status,
		metadata: meta,
	};
}

function workerToEntity(w: AcpWidgetWorker): AcpPanelEntity {
	const meta: AcpPanelEntityMetadata = {
		kind: "worker",
	};
	if (w.currentTaskId) meta.currentTaskId = w.currentTaskId;
	return {
		id: w.name,
		name: w.name,
		status: w.stale ? "stale" : w.status,
		tokens: w.tokenCountTotal,
		metadata: meta,
	};
}

/**
 * Build read-only panel deps from the widget state + task list.
 * Mutations throw a typed error (overview mode never calls them).
 */
export function buildAcpPanelDepsReadOnly(sources: ReadOnlyPanelSources): AcpPanelDeps {
	const { state, tasks } = sources;
	return {
		getEntities(): AcpPanelEntity[] {
			const sessions = state.sessions.map(sessionToEntity);
			const workers = (state.workers ?? []).map(workerToEntity);
			return [...sessions, ...workers];
		},
		getTasks(): AcpPanelTask[] {
			return tasks;
		},
		async sendMessage(): Promise<void> {
			throw new Error(READ_ONLY_MSG);
		},
		abortEntity(): void {
			throw new Error(READ_ONLY_MSG);
		},
		killEntity(): void {
			throw new Error(READ_ONLY_MSG);
		},
		async reassignTask(): Promise<boolean> {
			throw new Error(READ_ONLY_MSG);
		},
		async unassignTask(): Promise<boolean> {
			throw new Error(READ_ONLY_MSG);
		},
		getTranscript(): AcpPanelTranscriptEntry[] {
			return [];
		},
	};
}

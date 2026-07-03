/**
 * Full (interactive) panel deps: extends the read-only entity/task mapping with
 * real mutations wired to the coordinator, mailbox manager, session manager, and
 * task store. Used by the D2 interactive overlay (`ctx.ui.custom()` via the
 * `/acp panel` command).
 *
 * Mutations are best-effort: failures are swallowed and the panel re-renders
 * with the resulting state. None of these throw to the caller — the panel's
 * `handleKey` is async and a throw would break the overlay.
 */
import type { AcpWidgetState } from "../acp-widget.js";
import type {
	AcpPanelDeps,
	AcpPanelEntity,
	AcpPanelTask,
	AcpPanelTranscriptEntry,
} from "./acp-panel.js";
import { buildAcpPanelDepsReadOnly } from "./panel-deps.js";

/** Inputs the full adapter consumes (all live getters). */
export interface FullPanelSources {
	getState: () => AcpWidgetState;
	getTasks: () => AcpPanelTask[];
	/** Send a mailbox message to an entity (session or worker). */
	sendMessage: (to: string, text: string) => Promise<void>;
	/** Abort the current operation on an entity (cancel prompt). */
	abortEntity: (entityId: string) => void;
	/** Force-kill/dispose an entity. */
	killEntity: (entityId: string) => void;
	/** Reassign a task to a new owner. Returns true on success. */
	reassignTask: (taskId: string, newOwner: string) => Promise<boolean>;
	/** Unassign a task (clear owner). Returns true on success. */
	unassignTask: (taskId: string) => Promise<boolean>;
	/** Fetch the transcript for an entity (best-effort; may be empty). */
	getTranscript: (entityId: string) => AcpPanelTranscriptEntry[];
}

/**
 * Build full panel deps. Entity + task getters reuse the read-only adapter's
 * mapping; mutations delegate to the supplied sources.
 */
export function buildAcpPanelDepsFull(sources: FullPanelSources): AcpPanelDeps {
	const readOnly = buildAcpPanelDepsReadOnly({
		getState: sources.getState,
		getTasks: sources.getTasks,
	});
	return {
		getEntities: (): AcpPanelEntity[] => readOnly.getEntities(),
		getTasks: (): AcpPanelTask[] => readOnly.getTasks(),
		async sendMessage(to: string, text: string): Promise<void> {
			await sources.sendMessage(to, text);
		},
		abortEntity(entityId: string): void {
			sources.abortEntity(entityId);
		},
		killEntity(entityId: string): void {
			sources.killEntity(entityId);
		},
		async reassignTask(taskId: string, newOwner: string): Promise<boolean> {
			return sources.reassignTask(taskId, newOwner);
		},
		async unassignTask(taskId: string): Promise<boolean> {
			return sources.unassignTask(taskId);
		},
		getTranscript(entityId: string): AcpPanelTranscriptEntry[] {
			return sources.getTranscript(entityId);
		},
	};
}

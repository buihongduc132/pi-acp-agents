/**
 * Heartbeat delta parsing — defensive parsing for ACP session/update events.
 *
 * Task 2.2: malformed/missing fields are treated as zero-delta rather than
 * crashing the heartbeat consumer. A thrown error is propagated to the caller
 * so it can be logged via `AcpEventLog` (`heartbeat_parse_error`).
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";

export interface HeartbeatDeltas {
	tokenDelta: number;
	toolCallDelta: number;
}

/**
 * Dependencies for {@link consumeHeartbeat}. Injected so the consumer is a
 * pure, testable function (no filesystem / global state required in tests).
 */
export interface HeartbeatConsumerDeps {
	/** Resolve the worker name bound to a session id (undefined = not worker-bound). */
	resolveWorkerName(sessionId: string): string | undefined;
	/** Apply deltas to a worker (wraps `WorkerStore.touch`). May throw. */
	touch(
		name: string,
		deltas?: { tokenDelta?: number; toolCallDelta?: number },
	): unknown;
	/** Log a malformed/unexpected event to `AcpEventLog` (`heartbeat_parse_error`). */
	logParseError(entry: {
		workerName: string;
		sessionId: string;
		error: string;
	}): void;
}

/**
 * Parse token/tool deltas from a single session/update event.
 *
 * - `usage_update`: extracts `used` tokens; missing/non-number `used`/`size`
 *   are treated as zero (defensive).
 * - `tool_call`: counts as one tool call.
 * - Any other (or missing) `sessionUpdate`: zero-delta.
 *
 * @throws never for malformed input — defensive guards handle all shapes.
 */
export function parseHeartbeatDeltas(update: SessionUpdate): HeartbeatDeltas {
	const updateRec = update as Record<string, unknown>;
	const updateType = updateRec.sessionUpdate;
	let tokenDelta = 0;
	let toolCallDelta = 0;

	if (updateType === "usage_update") {
		// Defensive: treat missing/non-number 'used' as zero-delta
		const used = typeof updateRec.used === "number" ? updateRec.used : 0;
		const size = typeof updateRec.size === "number" ? updateRec.size : 0;
		tokenDelta = used;
		void size; // size is total context window, not useful as delta
	} else if (updateType === "tool_call") {
		toolCallDelta = 1;
	}

	return { tokenDelta, toolCallDelta };
}

/**
 * Heartbeat consumer — process a single ACP `session/update` for a
 * worker-bound session: defensively parse deltas, apply them via
 * `WorkerStore.touch`, and log any thrown error as `heartbeat_parse_error`
 * without crashing the event stream.
 *
 * (Tasks 2.1 + 2.2: defensive parsing built-in via {@link parseHeartbeatDeltas}.)
 *
 * Exported so it is unit-testable; the production wiring in `index.ts`
 * delegates to this function.
 */
export function consumeHeartbeat(
	deps: HeartbeatConsumerDeps,
	sessionId: string,
	update: SessionUpdate,
): void {
	const workerName = deps.resolveWorkerName(sessionId);
	if (!workerName) return; // Not a worker-bound session
	try {
		const { tokenDelta, toolCallDelta } = parseHeartbeatDeltas(update);
		deps.touch(workerName, { tokenDelta, toolCallDelta });
	} catch (err) {
		deps.logParseError({
			workerName,
			sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

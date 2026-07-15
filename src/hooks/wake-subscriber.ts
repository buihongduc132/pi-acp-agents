/**
 * WakeSubscriber — subscribes to events.sock, filters `acp.*` events, and
 * delivers them to pi via sendMessage(content, {customType, display, details},
 * {triggerTurn|deliverAs}) (LD1).
 *
 * Key design decisions (locked):
 * - LD1: sendMessage+customType within hooks, NO intercom broker
 * - LD2: Copy pi-intercom's queue+flush pattern — buffer when busy, flush when idle
 *
 * Resolved open threads:
 * - OT8-refined: System-notification framing ([acp:system] prefix)
 * - OT9: turnInFlight flag prevents TOCTOU race
 * - OT11: reconnect() ALWAYS uses deliverAs:'followUp'
 * - OT12: pi adapter has isIdle() method
 * - OT15: Mode-branched renderer (getRendererConfig)
 * - OT18: Fire-and-forget triggerTurn
 * - OT25: session_failed throttled at 200ms
 * - OT26: Yield on pending user question
 * - OT27: session_started muted by default
 * - OT28: subagent_stop muted by default
 * - OT29: Correlation-based coalescing
 */
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

import { NEVER_DROP_EVENT_TYPES, type SocketEvent } from "./types.js";

const ACP_PREFIX = "acp.";
const DEFAULT_RING_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_MESSAGE_LENGTH = 500;
const DEFAULT_COALESCE_WINDOW_MS = 0; // Disabled by default, opt-in
const DEFAULT_MUTED_EVENT_TYPES = [
	"acp.session_started",
	"acp.subagent_stop",
	"acp.subagent_start",
];
/**
 * Reconnect safety rails (HOTFIX — 152GB log regression):
 * A socket that connects-then-immediately-closes (flapping peer / TCP reset
 * after SYN/ACK) previously drove a zero-backoff hot loop in
 * reconnectAfterClose: each cycle logged one line and reconnected instantly,
 * producing ~170KB/s of identical log spam that filled 152GB in production.
 *
 * - DEFAULT_MAX_RECONNECT_ATTEMPTS: lifetime cap on reconnect attempts. Once
 *   exceeded, the subscriber stops trying (goes dormant / falls back to
 *   intercom) instead of reconnecting forever.
 * - RECONNECT_LOG_MAX_PER_SEC: rate-limit ceiling for the "scheduling
 *   reconnect" log line, preventing unbounded log growth even if reconnects
 *   somehow speed up.
 * - Exponential backoff base uses retryDelayMs (configurable) and is capped
 *   by RECONNECT_BACKOFF_MAX_MS. It is applied in reconnectAfterClose so it
 *   gates EVERY reconnect cycle, not only failed connects (which start()
 *   already delays).
 */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_LOG_MAX_PER_SEC = 5;
/** Reconnect backoff doubles up to this cap (exponential, bounded). */
const RECONNECT_BACKOFF_MAX_MS = 30_000;
/**
 * Minimum backoff floor, INDEPENDENT of retryDelayMs. Ensures exponential
 * backoff is never defeated by retryDelayMs: 0 (which would make every delay
 * 0*2^n = 0). This floor is the hard minimum gap between reconnect cycles.
 */
const RECONNECT_BACKOFF_FLOOR_MS = 1000;
/**
 * Cooldown (ms) after which reconnectAttempts resets to 0 if no reconnect
 * activity occurs. This allows recovery: if the socket stabilizes, the
 * lifetime budget is replenished so future transient flaps don't accumulate
 * toward permanent dormancy.
 */
const RECONNECT_RESET_COOLDOWN_MS = 60_000;

/** Shell metacharacters that must be neutralized before delivery. */
const SHELL_METACHARS = /[;|&$`<>]/g;
/** Prompt-injection patterns (matched case-insensitively). */
const INJECTION_PATTERNS: readonly RegExp[] = [
	/ignore previous instructions/gi,
	/you are now/gi,
	/system\s*:/gi,
];

/** Minimal socket-like interface (real Socket or injected mock). */
export interface SocketLike {
	on(event: string, listener: (...args: any[]) => void): unknown;
	write(data: string): unknown;
	end(): unknown;
	destroy(): unknown;
}

export interface IntercomChannel {
	publish(message: string): Promise<void> | void;
}

/** Structured details passed with each wake message (OT20). */
export interface AcpWakeDetails {
	eventType: string;
	eventId: string;
	correlationId: string;
	agentName: string;
	cwd: string;
	task?: {
		id: string;
		subject: string;
		durationMs?: number;
		result?: string;
	};
}

/** Options for sendMessage (LD1). */
export interface SendMessageOptions {
	customType: string;
	display: boolean;
	details: AcpWakeDetails;
}

/** Delivery strategy for sendMessage. */
export interface SendMessageDelivery {
	triggerTurn?: boolean;
	deliverAs?: "followUp";
}

/**
 * New pi adapter interface (LD1 + OT12 + OT26).
 * - sendMessage: LD1 structured message delivery
 * - isIdle: OT12 idle detection
 * - hasPendingUserQuestion: OT26 yield on pending question (optional)
 */
export interface WakePiAdapter {
	sendMessage: (
		content: string,
		options: SendMessageOptions,
		delivery: SendMessageDelivery,
	) => Promise<void> | void;
	isIdle: () => boolean;
	hasPendingUserQuestion?: () => boolean;
	log?: (...args: unknown[]) => void;
	/** Legacy sendUserMessage — kept for backward compat during migration. */
	sendUserMessage?: (
		message: string,
		options?: { deliverAs?: string },
	) => Promise<void> | void;
}

export interface WakeSubscriberOptions {
	path: string;
	pi: WakePiAdapter;
	intercom?: IntercomChannel;
	maxSocketRetries?: number;
	retryDelayMs?: number;
	ringBufferSize?: number;
	/** Minimum interval (ms) between delivered messages. Events arriving
	 *  faster than this are dropped. Default: 1000ms. Completion events
	 *  (NEVER_DROP) are throttled at this rate too (OT25 — 200ms for failures). */
	minIntervalMs?: number;
	/** Maximum length of the delivered message before truncation. Default: 500. */
	maxMessageLength?: number;
	/** Injectable connector for testing. */
	connector?: () => Promise<SocketLike>;
	/** Event types to mute (not deliver). Default: ['acp.session_started', 'acp.subagent_stop'] (OT27, OT28). */
	mutedEventTypes?: string[];
	/** Coalesce window (ms) for grouping events by correlationId. Default: 200ms (OT29). */
	coalesceWindowMs?: number;
	/** Renderer mode: 'tui' or 'rpc'. Default: 'rpc' (OT15). */
	mode?: "tui" | "rpc";
	/**
	 * Maximum number of reconnect attempts after an unexpected close before the
	 * subscriber stops trying (goes dormant). Prevents infinite reconnect loops
	 * on a persistently flapping/unavailable socket. Default: 10.
	 * (HOTFIX — 152GB log regression.)
	 */
	maxReconnectAttempts?: number;
	/**
	 * Host session id for the ownership filter (F1). When set, events whose
	 * `payload.session.id` differs from this value are dropped — UNLESS the
	 * foreign session id is in `subscribedSessionIds`. Late-bound via
	 * `setHostSessionId()` once pi fires `session_start`.
	 *
	 * NOTE: session_completed is intentionally NOT muted — it is a NEVER_DROP
	 * lifecycle event that legitimately wakes the host when ITS OWN delegated
	 * session finishes. Foreign session_completed flooding is handled by this
	 * ownership filter (F1), not by global muting. Global muting would strip a
	 * core feature (wake-on-own-completion) and regress the formatting tests
	 * that depend on session_completed delivery.
	 */
	hostSessionId?: string;
	/**
	 * Explicitly subscribed foreign session ids that bypass the ownership
	 * filter (F1). Used when this host is intentionally observing another
	 * session's events (e.g. a watcher / fan-out target).
	 */
	subscribedSessionIds?: Set<string>;
}

/**
 * Format the wake-up message with system-notification framing (OT8-refined).
 * Format: [acp:system] event-type: agent-name — "task-subject" (duration)
 */
function formatWakeMessage(event: SocketEvent): string {
	const eventType = event["event-type"].replace(/^acp\./, "");
	const agentName = event.payload?.agent?.name ?? "unknown";
	const task = event.payload?.task;

	let content = `[acp:system] ${eventType}: ${agentName}`;

	if (task?.subject) {
		content += ` — "${task.subject}"`;
	}

	if (task?.durationMs !== undefined && task.durationMs !== null) {
		content += ` (${task.durationMs}ms)`;
	}

	if (task?.result) {
		content += ` — ${task.result}`;
	}

	return content;
}

/**
 * Format a coalesced wake message for a group of events sharing correlationId (OT29).
 */
function formatCoalescedMessage(events: SocketEvent[]): string {
	if (events.length === 1) {
		return formatWakeMessage(events[0]);
	}

	// Group by event type for roll-up
	const typeCounts = new Map<string, number>();
	const agentNames = new Set<string>();
	let taskId: string | undefined;

	for (const event of events) {
		const eventType = event["event-type"].replace(/^acp\./, "");
		typeCounts.set(eventType, (typeCounts.get(eventType) ?? 0) + 1);
		if (event.payload?.agent?.name) {
			agentNames.add(event.payload.agent.name);
		}
		if (event.payload?.task?.id) {
			taskId = event.payload.task.id;
		}
	}

	// Build roll-up message
	const parts: string[] = [];
	for (const [eventType, count] of typeCounts) {
		const noun = eventType.replace(/_/g, " ");
		parts.push(`${count} ${noun}${count > 1 ? "s" : ""}`);
	}

	let content = `[acp:system] ${parts.join(", ")}`;
	if (taskId) {
		content += ` in task ${taskId}`;
	}

	return content;
}

/** Build AcpWakeDetails from a SocketEvent (OT20). */
function buildDetails(event: SocketEvent): AcpWakeDetails {
	const details: AcpWakeDetails = {
		eventType: event["event-type"],
		eventId: event["event-id"],
		correlationId: event.payload?.correlationId ?? "",
		agentName: event.payload?.agent?.name ?? "unknown",
		cwd: event.payload?.session?.cwd ?? "",
	};

	if (event.payload?.task) {
		details.task = {
			id: event.payload.task.id,
			subject: event.payload.task.subject,
		};
		if (event.payload.task.durationMs !== undefined) {
			details.task.durationMs = event.payload.task.durationMs;
		}
		if (event.payload.task.result !== undefined) {
			details.task.result = event.payload.task.result;
		}
	}

	return details;
}

export class WakeSubscriber extends EventEmitter {
	private readonly path: string;
	private readonly pi: WakePiAdapter;
	private readonly intercom?: IntercomChannel;
	private readonly maxSocketRetries: number;
	private readonly retryDelayMs: number;
	private readonly ringBufferSize: number;
	private readonly minIntervalMs: number;
	private readonly maxMessageLength: number;
	private readonly connector: () => Promise<SocketLike>;
	private readonly mutedEventTypes: Set<string>;
	private readonly coalesceWindowMs: number;
	private readonly mode: "tui" | "rpc";
	/** Lifetime cap on reconnect attempts after close (HOTFIX). */
	private readonly maxReconnectAttempts: number;
	/** F1: host session id for the ownership filter (mutable — late-bound). */
	private hostSessionId?: string;
	/** F1: foreign session ids explicitly opted-in to delivery. */
	private readonly subscribedSessionIds?: Set<string>;

	private ring: SocketEvent[] = [];
	private socket: SocketLike | null = null;
	private alive = true;
	private usingIntercom = false;
	/** Reentrancy guard: true while a reconnect is in-flight. */
	private reconnecting = false;
	/** Timestamp (ms) of the last non-completion message delivery. */
	private lastDeliveredAt = 0;
	/** OT9: TOCTOU guard — true while a triggerTurn sendMessage is in-flight. */
	private turnInFlight = false;
	/** OT29: Coalesce groups keyed by correlationId. */
	private coalesceGroups = new Map<string, SocketEvent[]>();
	/** OT29: Timers for coalesce window expiry. */
	private coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** LD2: Local buffer for events when agent is busy. */
	private localBuffer: SocketEvent[] = [];
	/** OT25: Last session_failed delivery timestamp for throttling. */
	private lastSessionFailedAt = 0;
	/** HOTFIX: reconnect attempt counter for the current flap episode.
	 *  Resets to 0 after RECONNECT_RESET_COOLDOWN_MS of inactivity (recovery),
	 *  checked at the top of reconnectAfterClose when re-entry happens. */
	private reconnectAttempts = 0;
	/** HOTFIX: timestamp (ms) of the last reconnect attempt — used to detect
	 *  the cooldown window for budget recovery. */
	private lastReconnectAttemptAt = 0;
	/** HOTFIX: count of "scheduling reconnect" log lines emitted in the current
	 *  1-second window, for rate-limiting the reconnect log. */
	private reconnectLogCount = 0;
	/** HOTFIX: start (ms) of the current 1-second reconnect-log window. */
	private reconnectLogWindowStart = 0;
	/** HOTFIX: once maxReconnectAttempts is exhausted, this is set true so all
	 *  future close events short-circuit instead of re-entering the dead loop. */
	private reconnectExhausted = false;
	/** HOTFIX: timer for the cooldown recovery re-attempt. Cleared on stop(). */
	private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: WakeSubscriberOptions) {
		super();
		this.path = opts.path;
		this.pi = opts.pi;
		this.intercom = opts.intercom;
		this.maxSocketRetries = opts.maxSocketRetries ?? DEFAULT_MAX_RETRIES;
		this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.ringBufferSize = opts.ringBufferSize ?? DEFAULT_RING_SIZE;
		this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.maxMessageLength = opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
		this.connector = opts.connector ?? (() => this.defaultConnect());
		this.mutedEventTypes = new Set(
			opts.mutedEventTypes !== undefined
				? opts.mutedEventTypes
				: DEFAULT_MUTED_EVENT_TYPES,
		);
		this.coalesceWindowMs = opts.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
		this.mode = opts.mode ?? "rpc";
		this.maxReconnectAttempts =
			opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
		this.hostSessionId = opts.hostSessionId;
		this.subscribedSessionIds = opts.subscribedSessionIds;
	}

	/**
	 * Handle a single socket event. Filters non-acp events, applies muting (OT27/OT28),
	 * coalescing (OT29), rate limiting, and delivers via sendMessage (LD1).
	 * Never throws (error isolation).
	 */
	async handleEvent(event: SocketEvent): Promise<void> {
		try {
			if (!event["event-type"] || !event["event-type"].startsWith(ACP_PREFIX)) {
				return;
			}

			// F1: ownership filter — drop events from foreign sessions BEFORE the
			// mute check, ring buffer, and coalesce logic. This prevents a
			// host-wide events.sock bus from waking THIS session for another
			// session's activity. Foreign sessions are only delivered if they
			// were explicitly opted-in via subscribedSessionIds.
			//
			// Edge case: if hostSessionId is unset (not yet bound at construction),
			// do NOT filter — preserve current behavior until session_start fires.
			const evtSessionId = event.payload?.session?.id;
			if (
				this.hostSessionId !== undefined &&
				evtSessionId !== undefined &&
				evtSessionId !== this.hostSessionId &&
				!this.subscribedSessionIds?.has(evtSessionId)
			) {
				return;
			}

			// LD18: ring buffer for replay
			this.pushRing(event);

			// OT27/OT28 + F3: mute configured event types. The expanded default
			// list adds subagent_start (per-turn noise, symmetric with
			// subagent_stop). NOTE: session_completed is intentionally NOT muted —
			// it is a NEVER_DROP lifecycle event that legitimately wakes the host
			// on own-session completion; foreign floods are dropped by the F1
			// ownership filter above.
			if (this.mutedEventTypes.has(event["event-type"])) {
				return;
			}

			// OT29: coalesce by correlationId
			const correlationId = event.payload?.correlationId ?? "";
			if (correlationId && this.coalesceWindowMs > 0) {
				this.addToCoalesceGroup(correlationId, event);
				return;
			}

			// No coalescing — deliver immediately
			await this.deliverEvent(event);
		} catch (err) {
			// Defensive: never propagate handler exceptions
			this.log(`handleEvent error: ${String(err)}`);
		}
	}

	/**
	 * Add event to coalesce group and schedule flush (OT29).
	 */
	private addToCoalesceGroup(correlationId: string, event: SocketEvent): void {
		const group = this.coalesceGroups.get(correlationId);
		if (group) {
			group.push(event);
		} else {
			this.coalesceGroups.set(correlationId, [event]);
		}

		// Reset the coalesce timer for this group
		const existingTimer = this.coalesceTimers.get(correlationId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timer = setTimeout(() => {
			void this.flushCoalesceGroup(correlationId);
		}, this.coalesceWindowMs);

		this.coalesceTimers.set(correlationId, timer);
	}

	/**
	 * Flush a coalesce group — deliver all events in the group as one message.
	 */
	private async flushCoalesceGroup(correlationId: string): Promise<void> {
		const group = this.coalesceGroups.get(correlationId);
		this.coalesceGroups.delete(correlationId);
		this.coalesceTimers.delete(correlationId);

		if (!group || group.length === 0) return;

		// Rate limiter: applies to all events (OT25 — session_failed throttled too)
		const now = Date.now();
		if (now - this.lastDeliveredAt < this.minIntervalMs) {
			// Check if ANY event in the group is NEVER_DROP
			const hasNeverDrop = group.some((e) =>
				NEVER_DROP_EVENT_TYPES.has(e["event-type"]),
			);
			if (!hasNeverDrop) {
				return; // Drop the entire group
			}
		}
		this.lastDeliveredAt = now;

		// Build coalesced message
		const content = sanitizeMessage(
			formatCoalescedMessage(group),
			this.maxMessageLength,
		);

		// Use the first event's details (or build merged details)
		const details = buildDetails(group[0]);

		// Determine delivery strategy
		const delivery = this.computeDelivery();

		await this.doSend(content, { customType: "acp_wake", display: true, details }, delivery);
	}

	/**
	 * Deliver a single event via sendMessage (LD1).
	 */
	private async deliverEvent(event: SocketEvent): Promise<void> {
		// LD2: Buffer events when agent is busy (not idle)
		if (typeof this.pi.isIdle === "function" && !this.pi.isIdle()) {
			this.localBuffer.push(event);
			return;
		}

		// OT25: session_failed throttling at 200ms
		const isSessionFailed = event["event-type"] === "acp.session_failed";
		const now = Date.now();
		if (isSessionFailed && now - this.lastSessionFailedAt < 200) {
			return; // Throttled — drop
		}

		// Rate limiter: completion events (NEVER_DROP) bypass throttling
		const isNeverDrop = NEVER_DROP_EVENT_TYPES.has(event["event-type"]);
		if (!isNeverDrop && now - this.lastDeliveredAt < this.minIntervalMs) {
			return; // Throttled — drop
		}
		this.lastDeliveredAt = now;
		if (isSessionFailed) {
			this.lastSessionFailedAt = now;
		}

		const content = sanitizeMessage(
			formatWakeMessage(event),
			this.maxMessageLength,
		);
		const details = buildDetails(event);
		const delivery = this.computeDelivery();

		await this.doSend(content, { customType: "acp_wake", display: true, details }, delivery);
	}

	/**
	 * Compute delivery strategy based on idle state, turnInFlight, and pending question.
	 */
	private computeDelivery(): SendMessageDelivery {
		// OT9: if a triggerTurn is already in-flight, use followUp
		if (this.turnInFlight) {
			return { deliverAs: "followUp" };
		}

		// OT26: yield if there's a pending user question
		if (this.pi.hasPendingUserQuestion?.()) {
			return { deliverAs: "followUp" };
		}

		// LD2: idle-gate — if idle, triggerTurn; else followUp
		// Defensive: check if isIdle exists (some test mocks may not have it)
		if (typeof this.pi.isIdle === "function" && this.pi.isIdle()) {
			return { triggerTurn: true };
		}

		return { deliverAs: "followUp" };
	}

	/**
	 * LD2 + OT29: Flush locally buffered events and pending coalesce groups.
	 * Called when agent transitions from busy to idle.
	 */
	async flush(): Promise<void> {
		// Flush local buffer (LD2)
		if (this.localBuffer.length > 0) {
			const buffered = this.localBuffer.splice(0);
			for (const event of buffered) {
				// Re-deliver with current idle state
				await this.deliverEvent(event);
			}
		}

		// Flush pending coalesce groups (OT29)
		const groups = new Map(this.coalesceGroups);
		for (const [corrId, timer] of this.coalesceTimers) {
			clearTimeout(timer);
		}
		this.coalesceGroups.clear();
		this.coalesceTimers.clear();

		for (const [corrId, group] of groups) {
			if (group.length === 0) continue;

			const content = sanitizeMessage(
				formatCoalescedMessage(group),
				this.maxMessageLength,
			);
			const details = buildDetails(group[0]);

			// Flushed events get triggerTurn:true (agent is now idle)
			await this.doSend(
				content,
				{ customType: "acp_wake", display: true, details },
				{ triggerTurn: true },
			);
		}
	}

	/**
	 * Send via pi.sendMessage (LD1). Fire-and-forget for triggerTurn (OT18).
	 */
	private async doSend(
		content: string,
		options: SendMessageOptions,
		delivery: SendMessageDelivery,
	): Promise<void> {
		try {
			if (delivery.triggerTurn) {
				// OT9: set turnInFlight before sending
				this.turnInFlight = true;
				// OT18: fire-and-forget — don't await
				const result = this.pi.sendMessage(content, options, delivery);
				if (result && typeof (result as Promise<void>).catch === "function") {
					(result as Promise<void>).catch((err: unknown) => {
						this.log(`sendMessage (triggerTurn) failed: ${String(err)}`);
					}).finally(() => {
						this.turnInFlight = false;
					});
				} else {
					// Synchronous — clear flag immediately
					this.turnInFlight = false;
				}
			} else {
				// followUp — can await (resolves fast)
				await this.pi.sendMessage(content, options, delivery);
			}
		} catch (err) {
			this.log(`sendMessage failed: ${String(err)}`);
			this.turnInFlight = false;
		}
	}

	/**
	 * F1: late-bind the host session id once pi fires `session_start`. Allows
	 * the ownership filter to start filtering immediately after the host id is
	 * known, without requiring it at construction time.
	 */
	setHostSessionId(id: string): void {
		this.hostSessionId = id;
	}

	private pushRing(event: SocketEvent): void {
		this.ring.push(event);
		while (this.ring.length > this.ringBufferSize) {
			this.ring.shift();
		}
	}

	getBufferedEvents(): SocketEvent[] {
		return [...this.ring];
	}

	/**
	 * Replay ALL buffered events (LD18). OT11: ALWAYS uses deliverAs:'followUp'
	 * regardless of idle state.
	 */
	async reconnect(): Promise<void> {
		for (const event of this.ring) {
			// Skip muted events during replay too
			if (this.mutedEventTypes.has(event["event-type"])) {
				continue;
			}

			const content = sanitizeMessage(
				formatWakeMessage(event),
				this.maxMessageLength,
			);
			const details = buildDetails(event);

			try {
				// OT11: ALWAYS followUp for replay
				await this.pi.sendMessage(
					content,
					{ customType: "acp_wake", display: true, details },
					{ deliverAs: "followUp" },
				);
			} catch (err) {
				this.log(`reconnect replay failed: ${String(err)}`);
			}
		}
	}

	/**
	 * Get renderer configuration based on mode (OT15).
	 */
	getRendererConfig(): {
		customType: string;
		mode: string;
		component?: string;
		format?: string;
	} {
		const base = { customType: "acp_wake" };

		if (this.mode === "tui") {
			return { ...base, mode: "tui", component: "AcpWakeComponent" };
		}

		return { ...base, mode: "rpc", format: "text" };
	}

	private defaultConnect(): Promise<Socket> {
		return new Promise<Socket>((resolve, reject) => {
			let settled = false;
			const sock = createConnection(this.path);
			sock.setEncoding("utf8");
			let lineBuf = "";
			sock.on("data", (chunk: string) => {
				lineBuf += chunk;
				let idx: number;
				while ((idx = lineBuf.indexOf("\n")) >= 0) {
					const line = lineBuf.slice(0, idx).trim();
					lineBuf = lineBuf.slice(idx + 1);
					if (!line) continue;
					try {
						const evt = JSON.parse(line) as SocketEvent;
						void this.handleEvent(evt);
					} catch {
						/* LD5: skip malformed */
					}
				}
			});
			sock.once("connect", () => {
				if (!settled) {
					settled = true;
					resolve(sock);
				}
			});
			sock.once("error", (err) => {
				if (!settled) {
					settled = true;
					try {
						sock.destroy();
					} catch {
						/* already closed */
					}
					reject(err);
				}
			});
			// Persistent error handler
			sock.on("error", (err) => {
				this.rateLimitedLog(`socket error: ${String(err)}`);
			});
			// Close handler — trigger reconnect on unexpected close
			sock.on("close", () => {
				if (!this.alive) return;
				this.socket = null;
				void this.reconnectAfterClose();
			});
		});
	}

	/**
	 * Start the subscriber. Retries up to maxSocketRetries; on exhaustion,
	 * falls back to intercom channel (LD7 fallback).
	 */
	async start(): Promise<void> {
		// Re-entrancy guard: destroy stale socket before opening new one
		if (this.socket && !this.usingIntercom) {
			const stale = this.socket;
			this.socket = null;
			try {
				stale.destroy();
			} catch {
				/* ignore */
			}
		}
		let attempts = 0;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			try {
				const sock = await this.connector();
				this.socket = sock;
				this.usingIntercom = false;
				return;
			} catch (err) {
				attempts++;
				this.rateLimitedLog(`socket connect attempt ${attempts} failed: ${String(err)}`);
				if (attempts >= this.maxSocketRetries) {
					break;
				}
				await delay(this.retryDelayMs);
			}
		}

		// Intercom fallback
		this.usingIntercom = true;
		this.socket = null;
		if (this.intercom) {
			try {
				await this.intercom.publish("[ACP wake] socket unavailable — intercom fallback");
			} catch (err) {
				this.log(`intercom publish failed: ${String(err)}`);
			}
		}
	}

	/**
	 * Reconnect after an unexpected socket close. Reentrancy-guarded.
	 *
	 * HOTFIX (152GB log regression): enforces three safety rails so a
	 * connect→close flap cannot become a zero-backoff hot loop:
	 *  1. Exponential backoff with a FLOOR — minimum delay between reconnect
	 *     cycles. The floor (RECONNECT_BACKOFF_FLOOR_MS) is independent of
	 *     retryDelayMs so that retryDelayMs:0 cannot defeat the backoff.
	 *     Applied BEFORE start(), so it gates successful connects too.
	 *  2. maxReconnectAttempts — per-episode cap; once exhausted, the subscriber
	 *     falls back to intercom (if available) and goes dormant. The budget
	 *     RESETS after RECONNECT_RESET_COOLDOWN_MS of inactivity, so a transient
	 *     flap episode does not permanently kill wake delivery — the subscriber
	 *     recovers when the socket stabilizes.
	 *  3. RECONNECT_LOG_MAX_PER_SEC — rate-limits the "scheduling reconnect"
	 *     log line so even a fast flap cannot flood the log.
	 */
	private async reconnectAfterClose(): Promise<void> {
		if (!this.alive || this.reconnecting) {
			return;
		}
		this.reconnecting = true;
		try {
			const now = Date.now();

			// Recovery: if enough time has passed since the last reconnect
			// attempt, reset the episode budget. This ensures a transient flap
			// does not permanently exhaust the cap — once the socket stabilizes
			// (no close events for RECONNECT_RESET_COOLDOWN_MS), the subscriber
			// is fully operational again.
			if (
				this.reconnectAttempts > 0 &&
				this.lastReconnectAttemptAt > 0 &&
				now - this.lastReconnectAttemptAt > RECONNECT_RESET_COOLDOWN_MS
			) {
				this.reconnectAttempts = 0;
				this.reconnectExhausted = false;
			}

			// Cap: once the per-episode budget is spent, fall back to intercom
			// and go dormant. A cooldown timer is scheduled to re-attempt
			// connection after RECONNECT_RESET_COOLDOWN_MS, so the subscriber
			// can recover once the socket stabilizes — the recovery is
			// REACHABLE in production via this timer (not dependent on close
			// events, which can't fire when there's no socket).
			if (this.reconnectAttempts >= this.maxReconnectAttempts) {
				if (!this.reconnectExhausted) {
					this.reconnectExhausted = true;
					this.log(
						`reconnect attempts exhausted (${this.maxReconnectAttempts}) — falling back to intercom, will retry after ${RECONNECT_RESET_COOLDOWN_MS}ms cooldown`,
					);
					// Fall back to intercom so wake delivery is not silently lost.
					this.usingIntercom = true;
					if (this.intercom) {
						try {
							await this.intercom.publish(
								"[ACP wake] socket exhausted reconnect budget — intercom fallback",
							);
						} catch (err) {
							this.log(`intercom publish failed: ${String(err)}`);
						}
					}
					// Schedule a cooldown re-attempt: after the cooldown period,
					// reset the budget and try to reconnect. This makes recovery
					// reachable even though no close events can fire (socket=null).
					this.scheduleCooldownRecovery();
				}
				return;
			}

			// Rate-limited log: at most RECONNECT_LOG_MAX_PER_SEC per rolling
			// 1-second window. Prevents log floods.
			if (now - this.reconnectLogWindowStart >= 1000) {
				this.reconnectLogWindowStart = now;
				this.reconnectLogCount = 0;
			}
			if (this.reconnectLogCount < RECONNECT_LOG_MAX_PER_SEC) {
				this.reconnectLogCount++;
				this.log("socket closed unexpectedly — scheduling reconnect");
			}

			// Exponential backoff with a floor independent of retryDelayMs.
			// The floor ensures retryDelayMs:0 cannot recreate the hot loop.
			// Cap at RECONNECT_BACKOFF_MAX_MS to avoid pathological waits.
			const rawDelay = this.retryDelayMs * 2 ** Math.min(this.reconnectAttempts, 5);
			const expDelay = Math.min(
				Math.max(rawDelay, RECONNECT_BACKOFF_FLOOR_MS),
				RECONNECT_BACKOFF_MAX_MS,
			);
			await delay(expDelay);
			if (!this.alive) return; // stop() raced in during the delay

			this.reconnectAttempts++;
			this.lastReconnectAttemptAt = Date.now();
			this.reconnectExhausted = false; // active attempt clears dormancy

			await this.start();
			// After successful reconnect, replay buffered events.
			if (this.socket && this.alive) {
				await this.reconnect();
			}
		} catch (err) {
			this.log(`reconnectAfterClose failed: ${String(err)}`);
		} finally {
			this.reconnecting = false;
		}
	}

	/**
	 * Schedule a cooldown recovery re-attempt. After RECONNECT_RESET_COOLDOWN_MS,
	 * resets the reconnect budget and tries to reconnect. This makes the recovery
	 * path reachable in production: when the socket is exhausted and null, no
	 * close events can fire, so reconnectAfterClose would never be re-invoked
	 * without this timer-driven re-entry.
	 */
	private scheduleCooldownRecovery(): void {
		if (this.cooldownTimer) {
			clearTimeout(this.cooldownTimer);
		}
		this.cooldownTimer = setTimeout(() => {
			this.cooldownTimer = null;
			if (!this.alive) return;
			// Reset the budget and attempt reconnection.
			this.reconnectAttempts = 0;
			this.reconnectExhausted = false;
			this.usingIntercom = false;
			void this.reconnectAfterClose();
		}, RECONNECT_RESET_COOLDOWN_MS);
	}

	isUsingIntercom(): boolean {
		return this.usingIntercom;
	}

	isAlive(): boolean {
		return this.alive;
	}

	async stop(): Promise<void> {
		this.alive = false;
		this.reconnecting = false;
		// Clear cooldown recovery timer
		if (this.cooldownTimer) {
			clearTimeout(this.cooldownTimer);
			this.cooldownTimer = null;
		}
		// Clear all coalesce timers
		for (const timer of this.coalesceTimers.values()) {
			clearTimeout(timer);
		}
		this.coalesceGroups.clear();
		this.coalesceTimers.clear();

		const s = this.socket;
		this.socket = null;
		if (s) {
			try {
				s.end();
			} catch {
				/* ignore */
			}
			try {
				s.destroy();
			} catch {
				/* ignore */
			}
		}
	}

	private log(msg: string): void {
		if (this.pi.log) {
			this.pi.log(`[wake-subscriber] ${msg}`);
		}
	}

	/**
	 * Rate-limited log for hot-path messages (socket errors, connect retries).
	 * Shares the same rolling 1-second window + cap as the reconnect log so
	 * that a flapping socket cannot flood the log through ANY code path.
	 */
	private rateLimitedLog(msg: string): void {
		const now = Date.now();
		if (now - this.reconnectLogWindowStart >= 1000) {
			this.reconnectLogWindowStart = now;
			this.reconnectLogCount = 0;
		}
		if (this.reconnectLogCount < RECONNECT_LOG_MAX_PER_SEC) {
			this.reconnectLogCount++;
			this.log(msg);
		}
	}
}

/**
 * Sanitize a wake message before delivery.
 * - Collapse newlines to single spaces
 * - Remove shell metacharacters
 * - Neutralize prompt-injection patterns
 * - Truncate to maxLen
 */
function sanitizeMessage(message: string, maxLen: number): string {
	let out = message;
	// Collapse all newline forms to a single space.
	out = out.replace(/[\r\n]+/g, " ");
	// Remove shell metacharacters entirely.
	out = out.replace(SHELL_METACHARS, "");
	// Neutralize prompt-injection patterns.
	let prev: string;
	do {
		prev = out;
		for (const re of INJECTION_PATTERNS) {
			out = out.replace(re, "[FILTERED]");
		}
	} while (out !== prev);
	// Enforce maximum length.
	if (out.length > maxLen) {
		out = out.slice(0, maxLen);
	}
	return out;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

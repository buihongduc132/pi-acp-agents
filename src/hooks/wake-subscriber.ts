/**
 * WakeSubscriber — subscribes to events.sock, filters `acp.*` events, and
 * delivers them to pi via sendUserMessage({ deliverAs: "followUp" }) (LD16).
 *
 * - LD7: socket subscriber → sendUserMessage
 * - LD16: ALWAYS deliverAs:"followUp"
 * - LD18: ring buffer (100) replayed on reconnect
 * - Intercom fallback after maxSocketRetries failures
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

export interface WakeSubscriberOptions {
	path: string;
	pi: {
		sendUserMessage: (
			message: string,
			options?: { deliverAs?: string },
		) => Promise<void> | void;
		log?: (...args: unknown[]) => void;
	};
	intercom?: IntercomChannel;
	maxSocketRetries?: number;
	retryDelayMs?: number;
	ringBufferSize?: number;
	/** Minimum interval (ms) between delivered messages. Events arriving
	 *  faster than this are dropped. Default: 1000ms. Completion events
	 *  (NEVER_DROP) bypass the limiter. */
	minIntervalMs?: number;
	/** Maximum length of the delivered message before truncation. Default: 500. */
	maxMessageLength?: number;
	/** Injectable connector for testing. */
	connector?: () => Promise<SocketLike>;
}

/**
 * Format the wake-up message delivered to pi. Includes the event-type and
 * event-id so consumers/tests can match on either.
 */
function formatWakeMessage(event: SocketEvent): string {
	const task = event.payload?.task;
	const parts = [
		event["event-type"],
		`event-id=${event["event-id"]}`,
	];
	if (event.payload?.correlationId) {
		parts.push(`correlationId=${event.payload.correlationId}`);
	}
	if (task) {
		parts.push(`task=${task.id}`);
		if (task.subject) parts.push(`subject="${task.subject}"`);
	}
	return `[ACP wake] ${parts.join(" ")}`;
}

export class WakeSubscriber extends EventEmitter {
	private readonly path: string;
	private readonly pi: WakeSubscriberOptions["pi"];
	private readonly intercom?: IntercomChannel;
	private readonly maxSocketRetries: number;
	private readonly retryDelayMs: number;
	private readonly ringBufferSize: number;
	private readonly minIntervalMs: number;
	private readonly maxMessageLength: number;
	private readonly connector: () => Promise<SocketLike>;

	private ring: SocketEvent[] = [];
	private socket: SocketLike | null = null;
	private alive = true;
	private usingIntercom = false;
	/** Reentrancy guard: true while a reconnect is in-flight. Prevents
	 *  reconnect storms (unbounded socket creation) when the peer flaps. */
	private reconnecting = false;
	/** Timestamp (ms) of the last non-completion message delivery. */
	private lastDeliveredAt = 0;

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
		this.connector =
			opts.connector ?? (() => this.defaultConnect());
	}

	/**
	 * Handle a single socket event. Filters non-acp events, buffers acp
	 * events (LD18), applies rate limiting + injection mitigation, and
	 * delivers via sendUserMessage with deliverAs:"followUp".
	 * Never throws (error isolation).
	 */
	async handleEvent(event: SocketEvent): Promise<void> {
		try {
			if (!event["event-type"] || !event["event-type"].startsWith(ACP_PREFIX)) {
				return;
			}

			// LD18: ring buffer for replay
			this.pushRing(event);

			// Rate limiter: completion events (NEVER_DROP) bypass throttling
			// but still update lastDeliveredAt to prevent burst after completion.
			const isNeverDrop = NEVER_DROP_EVENT_TYPES.has(event["event-type"]);
			const now = Date.now();
			if (!isNeverDrop && now - this.lastDeliveredAt < this.minIntervalMs) {
				// Throttled — drop this event
				return;
			}
			this.lastDeliveredAt = now;

			const message = sanitizeMessage(
				formatWakeMessage(event),
				this.maxMessageLength,
			);
			try {
				await this.pi.sendUserMessage(message, { deliverAs: "followUp" });
			} catch (err) {
				// Error isolation: log + swallow, keep loop alive (SG4)
				this.log(`sendUserMessage failed: ${String(err)}`);
			}
		} catch (err) {
			// Defensive: never propagate handler exceptions
			this.log(`handleEvent error: ${String(err)}`);
		}
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
	 * Replay ALL buffered events (LD18). Re-delivers each via
	 * sendUserMessage with deliverAs:"followUp". Rate limiter is NOT
	 * applied during replay — these events were already missed once
	 * during disconnection and must be delivered.
	 */
	async reconnect(): Promise<void> {
		for (const event of this.ring) {
			const message = sanitizeMessage(
				formatWakeMessage(event),
				this.maxMessageLength,
			);
			try {
				await this.pi.sendUserMessage(message, { deliverAs: "followUp" });
			} catch (err) {
				this.log(`reconnect replay failed: ${String(err)}`);
			}
		}
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
					// Destroy the failed socket so its fd is released immediately.
					// Without this, rapid reconnect retries leak sockets → EMFILE.
					try {
						sock.destroy();
					} catch {
						/* already closed */
					}
					reject(err);
				}
			});
			// Persistent error handler — prevent unhandled error crash after connection
			sock.on("error", (err) => {
				this.log(`socket error: ${String(err)}`);
			});
			// Close handler — trigger reconnect on unexpected close.
			// Dedup/serialization lives inside reconnectAfterClose() so that
			// overlapping close events never spawn parallel reconnect loops.
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
		// Re-entrancy guard: if we already hold a live, non-intercom socket,
		// destroy it before opening a new one to avoid orphaned fd leaks.
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
				this.log(`socket connect attempt ${attempts} failed: ${String(err)}`);
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
	 * Reconnect after an unexpected socket close. Retries connection
	 * using the same logic as start(), then replays the ring buffer (LD18).
	 *
	 * Reentrancy-guarded: if a reconnect is already in-flight (or the
	 * subscriber has been stopped), this is a no-op. This prevents
	 * reconnect storms — unbounded socket creation → EMFILE — when the
	 * peer flaps and multiple close events arrive while a reconnect is pending.
	 */
	private async reconnectAfterClose(): Promise<void> {
		if (!this.alive || this.reconnecting) {
			return;
		}
		this.reconnecting = true;
		try {
			this.log("socket closed unexpectedly — scheduling reconnect");
			await this.start();
			// After successful reconnect, replay buffered events
			if (this.socket && this.alive) {
				await this.reconnect();
			}
		} catch (err) {
			this.log(`reconnectAfterClose failed: ${String(err)}`);
		} finally {
			this.reconnecting = false;
		}
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
}

/**
 * Sanitize a wake message before delivery to pi.sendUserMessage.
 *
 * - Collapse newlines (\r, \n) to single spaces (anti multi-line injection).
 * - Remove shell metacharacters (; | & $ ` < >).
 * - Neutralize known prompt-injection phrases.
 * - Truncate to maxLen.
 */
function sanitizeMessage(message: string, maxLen: number): string {
	let out = message;
	// Collapse all newline forms to a single space.
	out = out.replace(/[\r\n]+/g, " ");
	// Remove shell metacharacters entirely.
	out = out.replace(SHELL_METACHARS, "");
	// Neutralize prompt-injection patterns. Replace with [FILTERED] marker
	// and repeat until stable to prevent re-assembly attacks.
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

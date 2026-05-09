/**
 * ACP Protocol Validation — behavior-based detection of non-ACP agents.
 *
 * Validates that an agent actually speaks the Agent Client Protocol by checking
 * response shapes at runtime. Does NOT judge by command name.
 *
 * When a mismatch is detected, throws `AcpProtocolError` with an actionable message
 * explaining what went wrong and how to fix it.
 */

/** Thrown when an agent's behavior doesn't match ACP protocol */
export class AcpProtocolError extends Error {
	readonly agentName: string;
	readonly command: string;
	readonly phase: AcpPhase;
	readonly cause_detail: string;

	constructor(opts: {
		agentName: string;
		command: string;
		phase: AcpPhase;
		message: string;
		cause: string;
	}) {
		super(
			`[ACP Protocol Mismatch] Agent "${opts.agentName}" (${opts.command}) failed at ${opts.phase}:\n` +
			`  ${opts.message}\n` +
			`  Cause: ${opts.cause}\n` +
			`  Fix: verify the command speaks ACP over stdio (nd-JSON). ` +
			`For Zed/JetBrains-style config, use: { "command": "<agent>", "args": ["acp"] }`,
		);
		this.name = "AcpProtocolError";
		this.agentName = opts.agentName;
		this.command = opts.command;
		this.phase = opts.phase;
		this.cause_detail = opts.cause;
	}
}

/** Phases of ACP protocol where mismatches can occur */
export type AcpPhase =
	| "spawn"
	| "connect"
	| "initialize"
	| "newSession"
	| "prompt"
	| "response_shape";

/**
 * Validate the `initialize` response has the minimum ACP shape.
 *
 * Per ACP spec, initialize MUST return:
 * - protocolVersion: string
 *
 * And SHOULD return (may be absent in older agents):
 * - agentCapabilities: object
 * - agentInfo: { name?: string, version?: string }
 */
export function validateInitializeResponse(
	resp: unknown,
	agentName: string,
	command: string,
): void {
	if (!resp || typeof resp !== "object") {
		throw new AcpProtocolError({
			agentName,
			command,
			phase: "initialize",
			message: `Response is ${resp === null ? "null" : typeof resp}, expected an object.`,
			cause: "The agent did not return a valid JSON-RPC response to the 'initialize' method. " +
				"This usually means the command does not speak ACP, or it printed non-JSON output to stdout.",
		});
	}

	const r = resp as Record<string, unknown>;

	if (!("protocolVersion" in r)) {
		throw new AcpProtocolError({
			agentName,
			command,
			phase: "initialize",
			message: "Missing 'protocolVersion' field.",
			cause: "The response does not look like an ACP InitializeResponse. " +
				"The command may speak a different protocol or returned an error. " +
				"Got keys: " + Object.keys(r).join(", "),
		});
	}

	// Warn but don't fail on missing optional fields
	if (!("agentCapabilities" in r) && !("capabilities" in r)) {
		// Log but don't throw — agentCapabilities is optional in the spec
	}
}

/**
 * Validate the `newSession` response has the minimum ACP shape.
 *
 * Per ACP spec, newSession MUST return:
 * - sessionId: string
 */
export function validateNewSessionResponse(
	resp: unknown,
	agentName: string,
	command: string,
): void {
	if (!resp || typeof resp !== "object") {
		throw new AcpProtocolError({
			agentName,
			command,
			phase: "newSession",
			message: `Response is ${resp === null ? "null" : typeof resp}, expected an object.`,
			cause: "The agent did not return a valid response to the 'session/new' method.",
		});
	}

	const r = resp as Record<string, unknown>;

	if (!("sessionId" in r) || typeof r.sessionId !== "string" || !r.sessionId) {
		throw new AcpProtocolError({
			agentName,
			command,
			phase: "newSession",
			message: "Missing or invalid 'sessionId' field.",
			cause: "ACP requires a 'sessionId' string in the newSession response. " +
				"Got keys: " + Object.keys(r).join(", "),
		});
	}
}

/**
 * Validate the `prompt` response has the minimum ACP shape.
 *
 * Per ACP spec, prompt MUST return:
 * - stopReason: string
 */
export function validatePromptResponse(
	resp: unknown,
	agentName: string,
	command: string,
): void {
	if (!resp || typeof resp !== "object") {
		throw new AcpProtocolError({
			agentName,
			command,
			phase: "prompt",
			message: `Response is ${resp === null ? "null" : typeof resp}, expected an object.`,
			cause: "The agent did not return a valid response to the 'prompt' method.",
		});
	}

	const r = resp as Record<string, unknown>;

	if (!("stopReason" in r)) {
		throw new AcpProtocolError({
			agentName,
			command,
			phase: "prompt",
			message: "Missing 'stopReason' field.",
			cause: "ACP requires 'stopReason' in the prompt response. " +
				"Got keys: " + Object.keys(r).join(", "),
		});
	}
}

/**
 * Classify an error from the ACP connection phase.
 * Returns an AcpProtocolError if the error indicates a protocol mismatch,
 * or the original error if it's something else (network, timeout, etc).
 */
export function classifyConnectionError(
	err: unknown,
	agentName: string,
	command: string,
	stderr?: string,
): Error {
	if (err instanceof AcpProtocolError) return err;

	const msg = err instanceof Error ? err.message : String(err);

	// Method not found (agent doesn't implement ACP) — check BEFORE ENOENT
	if (msg.includes("Method not found") || msg.includes("-32601")) {
		return new AcpProtocolError({
			agentName,
			command,
			phase: "initialize",
			message: "Agent does not implement the ACP 'initialize' method.",
			cause: "The command exists but doesn't speak ACP. " +
				"Ensure it's an ACP-compatible agent or you're passing the correct args (e.g., 'acp' or '--acp').",
		});
	}

	// Process exited before connection established
	if (msg.includes("ENOENT") || msg.includes("spawn")) {
		return new AcpProtocolError({
			agentName,
			command,
			phase: "spawn",
			message: `Command "${command}" could not be spawned.`,
			cause: msg + (stderr ? `\nStderr: ${stderr.slice(0, 500)}` : ""),
		});
	}

	// JSON parse errors (agent wrote non-JSON to stdout)
	if (msg.includes("JSON") || msg.includes("parse") || msg.includes("Unexpected token")) {
		return new AcpProtocolError({
			agentName,
			command,
			phase: "connect",
			message: "Agent output is not valid JSON-RPC.",
			cause: msg + (stderr ? `\nStderr: ${stderr.slice(0, 500)}` : ""),
		});
	}

	// Auth errors — NOT a protocol mismatch, just needs setup
	if (msg.includes("auth") || msg.includes("Auth") || msg.includes("401") || msg.includes("403")) {
		return err instanceof Error ? err : new Error(msg);
	}

	// Timeout — agent hung without responding
	if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("timed out")) {
		return new AcpProtocolError({
			agentName,
			command,
			phase: "connect",
			message: "Agent did not respond within timeout.",
			cause: "The process started but never sent a valid ACP response. " +
				"It may be waiting for interactive input, or the command doesn't speak ACP." +
				(stderr ? `\nStderr: ${stderr.slice(0, 500)}` : ""),
		});
	}

	// Unknown error — pass through as-is
	return err instanceof Error ? err : new Error(msg);
}

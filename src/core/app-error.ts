/**
 * Domain base error class for pi-acp-agents.
 *
 * All custom error classes in this package SHOULD extend `AppError` (not the
 * native `Error`) so that:
 *   1. catch blocks can discriminate domain errors from third-party errors via
 *      `instanceof AppError`;
 *   2. every domain error carries a stable `code` (machine-readable) and a
 *      human-readable `message`;
 *   3. errors can be serialized uniformly for logging / API responses.
 *
 * @see .sg-rules/error-must-extend-base.yml
 */
export class AppError extends Error {
	/** Stable machine-readable code (e.g. "ALL_AGENTS_FAILED"). */
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = this.constructor.name;
		this.code = code;
	}
}

/**
 * Branch coverage for session-lifecycle.ts — getSessionPruneReason
 */
import { describe, it, expect } from "vitest";
import { getSessionPruneReason, getSessionAutoCloseReason, isSessionAutoClosable } from "../src/core/session-lifecycle.js";

describe("session-lifecycle — branch coverage", () => {
	describe("getSessionPruneReason", () => {
		it("returns 'disposed' for disposed session", () => {
			const reason = getSessionPruneReason(
				{ disposed: true, busy: false },
				1000,
			);
			expect(reason).toBe("disposed");
		});

		it("returns undefined for active session", () => {
			const reason = getSessionPruneReason(
				{ disposed: false, busy: true, lastResponseAt: new Date() },
				1000,
			);
			expect(reason).toBeUndefined();
		});

		it("returns 'completed-idle' for idle completed session", () => {
			const old = new Date(Date.now() - 2000);
			const reason = getSessionPruneReason(
				{ disposed: false, busy: false, completedAt: old },
				1000,
			);
			expect(reason).toBe("completed-idle");
		});

		it("returns 'stalled-no-response' for stalled busy session", () => {
			const old = new Date(Date.now() - 2000);
			const reason = getSessionPruneReason(
				{ disposed: false, busy: true, lastResponseAt: old },
				1000,
			);
			expect(reason).toBe("stalled-no-response");
		});
	});

	describe("isSessionAutoClosable", () => {
		it("returns true for stalled session", () => {
			const old = new Date(Date.now() - 2000);
			expect(isSessionAutoClosable(
				{ disposed: false, busy: true, lastResponseAt: old },
				1000,
			)).toBe(true);
		});

		it("returns false for active session", () => {
			expect(isSessionAutoClosable(
				{ disposed: false, busy: true, lastResponseAt: new Date() },
				1000,
			)).toBe(false);
		});

		it("returns false for session with no completedAt", () => {
			expect(isSessionAutoClosable(
				{ disposed: false, busy: false },
				1000,
			)).toBe(false);
		});
	});
});

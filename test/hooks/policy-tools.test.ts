/**
 * RED tests for src/hooks/policy-tools.ts
 * Tests getHooksPolicyTool and setHooksPolicyTool.
 * Source does NOT exist yet — these MUST FAIL (RED phase).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	getHooksPolicyTool,
	setHooksPolicyTool,
} from "../../src/hooks/policy-tools.js";
import type { FailureAction, HookConfig } from "../../src/hooks/types.js";

// Mock store for persistence tests
function createMockStore(initial?: Partial<HookConfig>) {
	const store: Record<string, unknown> = {
		failureAction: initial?.failureAction ?? "warn",
		maxReopensPerTask: initial?.maxReopensPerTask ?? 3,
		followupOwner: initial?.followupOwner ?? "lead",
	};
	return {
		get: vi.fn((key: string) => store[key]),
		set: vi.fn((key: string, value: unknown) => {
			store[key] = value;
		}),
		delete: vi.fn((key: string) => {
			delete store[key];
		}),
		_raw: store,
	};
}

describe("policy-tools", () => {
	describe("acp_hooks_policy_get", () => {
		it("returns configured policy from store", async () => {
			const store = createMockStore({
				failureAction: "followup",
				maxReopensPerTask: 5,
				followupOwner: "member",
			});

			const result = await getHooksPolicyTool(store as any);
			expect(result).toBeDefined();
			expect(result.configured).toBeDefined();
			expect(result.configured.failureAction).toBe("followup");
			expect(result.configured.maxReopensPerTask).toBe(5);
			expect(result.configured.followupOwner).toBe("member");
		});

		it("returns effective policy with env fallback", async () => {
			const store = createMockStore();

			// Env var overrides store value for effective policy
			const originalEnv = process.env.ACP_HOOKS_FAILURE_ACTION;
			process.env.ACP_HOOKS_FAILURE_ACTION = "reopen";

			try {
				const result = await getHooksPolicyTool(store as any);
				expect(result.effective).toBeDefined();
				expect(result.effective.failureAction).toBe("reopen");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.ACP_HOOKS_FAILURE_ACTION;
				} else {
					process.env.ACP_HOOKS_FAILURE_ACTION = originalEnv;
				}
			}
		});

		it("falls back to defaults when store is empty", async () => {
			const store = createMockStore();
			store._raw.failureAction = undefined;
			store._raw.maxReopensPerTask = undefined;
			store._raw.followupOwner = undefined;

			const result = await getHooksPolicyTool(store as any);
			expect(result.effective.failureAction).toBe("warn");
			expect(result.effective.maxReopensPerTask).toBe(3);
			expect(result.effective.followupOwner).toBe("lead");
		});
	});

	describe("acp_hooks_policy_set", () => {
		let store: ReturnType<typeof createMockStore>;

		beforeEach(() => {
			store = createMockStore();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("updates failureAction at runtime", async () => {
			const result = await setHooksPolicyTool(store as any, {
				failureAction: "reopen",
			});
			expect(result.success).toBe(true);
			expect(store.set).toHaveBeenCalledWith("failureAction", "reopen");
		});

		it("updates maxReopensPerTask at runtime", async () => {
			const result = await setHooksPolicyTool(store as any, {
				maxReopensPerTask: 10,
			});
			expect(result.success).toBe(true);
			expect(store.set).toHaveBeenCalledWith("maxReopensPerTask", 10);
		});

		it("updates followupOwner at runtime", async () => {
			const result = await setHooksPolicyTool(store as any, {
				followupOwner: "none",
			});
			expect(result.success).toBe(true);
			expect(store.set).toHaveBeenCalledWith("followupOwner", "none");
		});

		it("updates multiple fields at once", async () => {
			const result = await setHooksPolicyTool(store as any, {
				failureAction: "reopen_followup",
				maxReopensPerTask: 7,
				followupOwner: "member",
			});
			expect(result.success).toBe(true);
			expect(store.set).toHaveBeenCalledWith("failureAction", "reopen_followup");
			expect(store.set).toHaveBeenCalledWith("maxReopensPerTask", 7);
			expect(store.set).toHaveBeenCalledWith("followupOwner", "member");
		});
	});

	describe("hooksPolicyReset=true", () => {
		it("clears team-level overrides", async () => {
			const store = createMockStore({
				failureAction: "reopen",
				maxReopensPerTask: 10,
				followupOwner: "member",
			});

			const result = await setHooksPolicyTool(store as any, {
				reset: true,
			});
			expect(result.success).toBe(true);
			// Should delete the override keys
			expect(store.delete).toHaveBeenCalled();
		});

		it("after reset, effective policy returns to defaults", async () => {
			const store = createMockStore({
				failureAction: "reopen",
				maxReopensPerTask: 10,
				followupOwner: "member",
			});

			await setHooksPolicyTool(store as any, { reset: true });

			const policy = await getHooksPolicyTool(store as any);
			expect(policy.effective.failureAction).toBe("warn");
			expect(policy.effective.maxReopensPerTask).toBe(3);
		});
	});

	describe("validation", () => {
		it("rejects unknown failureAction", async () => {
			const store = createMockStore();

			await expect(
				setHooksPolicyTool(store as any, {
					failureAction: "invalid_action" as FailureAction,
				}),
			).rejects.toThrow();
		});

		it("rejects unknown followupOwner", async () => {
			const store = createMockStore();

			await expect(
				setHooksPolicyTool(store as any, {
					followupOwner: "random_person" as any,
				}),
			).rejects.toThrow();
		});

		it("rejects negative maxReopensPerTask", async () => {
			const store = createMockStore();

			await expect(
				setHooksPolicyTool(store as any, {
					maxReopensPerTask: -1,
				}),
			).rejects.toThrow();
		});

		it("rejects non-integer maxReopensPerTask", async () => {
			const store = createMockStore();

			await expect(
				setHooksPolicyTool(store as any, {
					maxReopensPerTask: 2.5,
				}),
			).rejects.toThrow();
		});
	});

	describe("persistence", () => {
		it("policy changes survive reload (mock store)", async () => {
			const store = createMockStore();

			// Set a value
			await setHooksPolicyTool(store as any, {
				failureAction: "followup",
			});

			// Simulate reload: create new tool instance with same store
			const result = await getHooksPolicyTool(store as any);
			expect(result.configured.failureAction).toBe("followup");
		});
	});
});

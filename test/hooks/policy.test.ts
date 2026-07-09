import { describe, it, expect, vi } from "vitest";

import {
	applyFailurePolicy,
	FailurePolicyEngine,
} from "../../src/hooks/policy.js";
import type { FailureAction } from "../../src/hooks/types.js";

function makeTask(overrides: Record<string, unknown> = {}) {
	return {
		id: "task-1",
		subject: "original task",
		status: "completed",
		metadata: {
			qualityGateStatus: undefined as string | undefined,
			qualityGateFailureCount: 0,
			reopenedByQualityGateCount: 0,
			...overrides,
		},
	};
}

function makeContext(overrides: Record<string, unknown> = {}) {
	return {
		version: 1 as const,
		event: "task_completed" as const,
		source: "acp" as const,
		correlationId: "11111111-1111-1111-1111-111111111111",
		session: { id: "s", agent: "pi", cwd: "/tmp" },
		agent: { name: "coder", type: "acp" },
		task: { id: "task-1", subject: "original task", status: "completed" },
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

describe("applyFailurePolicy — warn", () => {
	it("warn logs and continues without side effects", async () => {
		const logger = { warn: vi.fn(), info: vi.fn() };
		const task = makeTask();

		const result = await applyFailurePolicy({
			action: "warn",
			context: makeContext(),
			task,
			logger,
		});

		expect(result.action).toBe("warn");
		expect(logger.warn).toHaveBeenCalled();
		// no task status change
		expect(task.status).toBe("completed");
		// no new task created
		expect(result.followupTask).toBeUndefined();
	});
});

describe("applyFailurePolicy — followup", () => {
	it("creates a followup task assigned to followupOwner", async () => {
		const logger = { warn: vi.fn(), info: vi.fn() };
		const task = makeTask();

		const result = await applyFailurePolicy({
			action: "followup",
			context: makeContext(),
			task,
			followupOwner: "lead",
			logger,
		});

		expect(result.action).toBe("followup");
		expect(result.followupTask).toBeDefined();
		expect(result.followupTask!.owner).toBe("lead");
		expect(result.followupTask!.subject.toLowerCase()).toContain("followup");
		expect(result.followupTask!.parentId).toBe("task-1");
	});

	it("can assign followup to member", async () => {
		const result = await applyFailurePolicy({
			action: "followup",
			context: makeContext(),
			task: makeTask(),
			followupOwner: "member",
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(result.followupTask!.owner).toBe("member");
	});
});

describe("applyFailurePolicy — reopen", () => {
	it("reopens source task (status → in_progress)", async () => {
		const task = makeTask();

		const result = await applyFailurePolicy({
			action: "reopen",
			context: makeContext(),
			task,
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(result.action).toBe("reopen");
		expect(task.status).toBe("in_progress");
	});

	it("increments reopenedByQualityGateCount", async () => {
		const task = makeTask({ reopenedByQualityGateCount: 1 });

		await applyFailurePolicy({
			action: "reopen",
			context: makeContext(),
			task,
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(task.metadata.reopenedByQualityGateCount).toBe(2);
	});
});

describe("applyFailurePolicy — reopen_followup", () => {
	it("reopens source task and creates followup", async () => {
		const task = makeTask();

		const result = await applyFailurePolicy({
			action: "reopen_followup",
			context: makeContext(),
			task,
			followupOwner: "lead",
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(result.action).toBe("reopen_followup");
		expect(task.status).toBe("in_progress");
		expect(result.followupTask).toBeDefined();
		expect(result.followupTask!.owner).toBe("lead");
	});
});

describe("applyFailurePolicy — maxReopensPerTask cap", () => {
	it("forces warn after cap is reached", async () => {
		const task = makeTask({ reopenedByQualityGateCount: 3 });

		const result = await applyFailurePolicy({
			action: "reopen",
			context: makeContext(),
			task,
			maxReopensPerTask: 3,
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(result.action).toBe("warn");
		expect(task.status).toBe("completed"); // not reopened
	});

	it("reopen_followup degrades to warn when cap reached", async () => {
		const task = makeTask({ reopenedByQualityGateCount: 3 });

		const result = await applyFailurePolicy({
			action: "reopen_followup",
			context: makeContext(),
			task,
			maxReopensPerTask: 3,
			followupOwner: "lead",
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(result.action).toBe("warn");
		expect(result.followupTask).toBeUndefined();
	});
});

describe("applyFailurePolicy — metadata stamp", () => {
	it("sets qualityGateStatus and qualityGateFailureCount", async () => {
		const task = makeTask({ qualityGateFailureCount: 0 });

		await applyFailurePolicy({
			action: "warn",
			context: makeContext(),
			task,
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(task.metadata.qualityGateStatus).toBe("failed");
		expect(task.metadata.qualityGateFailureCount).toBe(1);
	});

	it("increments qualityGateFailureCount on subsequent failures", async () => {
		const task = makeTask({ qualityGateFailureCount: 2 });

		await applyFailurePolicy({
			action: "warn",
			context: makeContext(),
			task,
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(task.metadata.qualityGateFailureCount).toBe(3);
	});

	it("sets reopenedByQualityGateCount when reopening", async () => {
		const task = makeTask({ reopenedByQualityGateCount: 0 });

		await applyFailurePolicy({
			action: "reopen",
			context: makeContext(),
			task,
			logger: { warn: vi.fn(), info: vi.fn() },
		});

		expect(task.metadata.reopenedByQualityGateCount).toBe(1);
	});
});

describe("FailurePolicyEngine", () => {
	it("can set/get policy via runtime overrides", async () => {
		const engine = new FailurePolicyEngine({
			failureAction: "warn" as FailureAction,
			maxReopensPerTask: 3,
			followupOwner: "lead",
		});

		expect(engine.getEffectivePolicy().failureAction).toBe("warn");

		engine.setOverride({ failureAction: "reopen" });
		expect(engine.getEffectivePolicy().failureAction).toBe("reopen");
		expect(engine.getEffectivePolicy().maxReopensPerTask).toBe(3);
	});

	it("reset clears overrides", async () => {
		const engine = new FailurePolicyEngine({
			failureAction: "warn" as FailureAction,
			maxReopensPerTask: 3,
			followupOwner: "lead",
		});

		engine.setOverride({ failureAction: "reopen" });
		engine.reset();
		expect(engine.getEffectivePolicy().failureAction).toBe("warn");
	});
});

import { describe, it, expect, vi } from "vitest";

import { buildHookContext } from "../../src/hooks/hook-context.js";
import type { HookEventName } from "../../src/hooks/types.js";

describe("buildHookContext — teams-compat superset", () => {
	const baseParams = {
		event: "task_completed" as HookEventName,
		session: { id: "sess-abc", agent: "pi", cwd: "/tmp/work" },
		agent: { name: "coder", type: "acp" },
	};

	it("returns version:1 and source:'acp'", () => {
		const ctx = buildHookContext(baseParams);
		expect(ctx.version).toBe(1);
		expect(ctx.source).toBe("acp");
	});

	it("includes all required top-level fields", () => {
		const ctx = buildHookContext(baseParams);
		expect(ctx).toHaveProperty("version");
		expect(ctx).toHaveProperty("event");
		expect(ctx).toHaveProperty("source");
		expect(ctx).toHaveProperty("session");
		expect(ctx).toHaveProperty("agent");
		expect(ctx).toHaveProperty("timestamp");
		expect(ctx).toHaveProperty("correlationId");
	});

	it("source is always 'acp' regardless of event type", () => {
		const events: HookEventName[] = [
			"session_started",
			"session_completed",
			"session_failed",
			"session_idle",
			"subagent_start",
			"subagent_stop",
			"task_assigned",
			"task_completed",
			"task_failed",
		];
		for (const event of events) {
			const ctx = buildHookContext({ ...baseParams, event });
			expect(ctx.source).toBe("acp");
		}
	});

	it("correlationId is a valid UUID (LD17)", () => {
		const ctx = buildHookContext(baseParams);
		// UUID v4 pattern
		const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		expect(ctx.correlationId).toMatch(uuidRe);
	});

	it("each call generates a unique correlationId (LD17 dedup)", () => {
		const ctx1 = buildHookContext(baseParams);
		const ctx2 = buildHookContext(baseParams);
		expect(ctx1.correlationId).not.toBe(ctx2.correlationId);
	});

	it("timestamp is valid ISO 8601", () => {
		const ctx = buildHookContext(baseParams);
		const parsed = new Date(ctx.timestamp);
		expect(parsed.toISOString()).toBe(ctx.timestamp);
	});

	it("event field matches the requested event", () => {
		const ctx = buildHookContext({ ...baseParams, event: "session_started" });
		expect(ctx.event).toBe("session_started");
	});

	it("session fields are populated", () => {
		const ctx = buildHookContext(baseParams);
		expect(ctx.session.id).toBe("sess-abc");
		expect(ctx.session.agent).toBe("pi");
		expect(ctx.session.cwd).toBe("/tmp/work");
	});

	it("agent fields are populated", () => {
		const ctx = buildHookContext(baseParams);
		expect(ctx.agent.name).toBe("coder");
		expect(ctx.agent.type).toBe("acp");
	});
});

describe("buildHookContext — optional fields", () => {
	const baseParams = {
		event: "session_started" as HookEventName,
		session: { id: "sess-x", agent: "pi", cwd: "/tmp" },
		agent: { name: "general", type: "acp" },
	};

	it("omits task when not provided", () => {
		const ctx = buildHookContext(baseParams);
		expect(ctx.task).toBeUndefined();
	});

	it("omits team when not provided", () => {
		const ctx = buildHookContext(baseParams);
		expect(ctx.team).toBeUndefined();
	});

	it("includes task when provided", () => {
		const ctx = buildHookContext({
			...baseParams,
			event: "task_completed",
			task: {
				id: "task-1",
				subject: "do thing",
				status: "completed",
				result: "ok",
				durationMs: 1234,
			},
		});
		expect(ctx.task).toBeDefined();
		expect(ctx.task!.id).toBe("task-1");
		expect(ctx.task!.subject).toBe("do thing");
		expect(ctx.task!.status).toBe("completed");
		expect(ctx.task!.result).toBe("ok");
		expect(ctx.task!.durationMs).toBe(1234);
	});

	it("includes team when provided", () => {
		const ctx = buildHookContext({
			...baseParams,
			team: { id: "team-alpha", leadName: "alice" },
		});
		expect(ctx.team).toBeDefined();
		expect(ctx.team!.id).toBe("team-alpha");
		expect(ctx.team!.leadName).toBe("alice");
	});

	it("serializes to valid JSON with all fields", () => {
		const ctx = buildHookContext({
			...baseParams,
			event: "task_completed",
			task: { id: "t-1", subject: "s", status: "completed" },
			team: { id: "tm-1", leadName: "bob" },
		});
		const json = JSON.stringify(ctx);
		const parsed = JSON.parse(json);
		expect(parsed.version).toBe(1);
		expect(parsed.source).toBe("acp");
		expect(parsed.correlationId).toBeDefined();
		expect(parsed.task.id).toBe("t-1");
		expect(parsed.team.id).toBe("tm-1");
	});
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GovernanceStore } from "../../src/management/governance-store.js";
import { SessionArchiveStore } from "../../src/management/session-archive-store.js";

describe("GovernanceStore", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "acp-gov-")); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	describe("plan approvals", () => {
		it("requests a plan", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			const plan = store.requestPlan("agent-1");
			expect(plan.agent).toBe("agent-1");
			expect(plan.status).toBe("pending");
		});

		it("gets an existing plan", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			store.requestPlan("agent-1");
			const plan = store.getPlan("agent-1");
			expect(plan).toBeDefined();
			expect(plan!.status).toBe("pending");
		});

		it("returns undefined for unknown agent", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			expect(store.getPlan("unknown")).toBeUndefined();
		});

		it("resolves an existing plan", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			store.requestPlan("agent-1");
			const resolved = store.resolvePlan("agent-1", "approved", "looks good");
			expect(resolved.status).toBe("approved");
			expect(resolved.feedback).toBe("looks good");
			expect(resolved.resolvedAt).toBeDefined();
		});

		it("resolves a plan that doesn't exist yet", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			const resolved = store.resolvePlan("agent-2", "rejected");
			expect(resolved.status).toBe("rejected");
		});
	});

	describe("model policy", () => {
		it("returns default policy", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			const policy = store.getModelPolicy();
			expect(policy.allowedModels).toEqual([]);
			expect(policy.blockedModels).toEqual([]);
			expect(policy.requireProviderPrefix).toBe(false);
		});

		it("sets partial policy", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			const updated = store.setModelPolicy({ blockedModels: ["bad-model"] });
			expect(updated.blockedModels).toEqual(["bad-model"]);
			expect(updated.allowedModels).toEqual([]);
		});

		it("checks model — no model provided", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			expect(store.checkModel()).toEqual({ ok: true, reason: "no model override provided" });
		});

		it("checks model — blocked", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			store.setModelPolicy({ blockedModels: ["bad"] });
			expect(store.checkModel("bad").ok).toBe(false);
			expect(store.checkModel("bad").reason).toContain("blocked");
		});

		it("checks model — allowed list blocks non-listed", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			store.setModelPolicy({ allowedModels: ["good"] });
			expect(store.checkModel("other").ok).toBe(false);
			expect(store.checkModel("other").reason).toContain("not in allowed list");
		});

		it("checks model — allowed list allows listed", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			store.setModelPolicy({ allowedModels: ["good"] });
			expect(store.checkModel("good").ok).toBe(true);
		});

		it("checks model — require provider prefix", () => {
			const store = new GovernanceStore(tmpDir, "ses-test-1");
			store.setModelPolicy({ requireProviderPrefix: true });
			expect(store.checkModel("no-slash").ok).toBe(false);
			expect(store.checkModel("provider/model").ok).toBe(true);
		});
	});
});

describe("SessionArchiveStore", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "acp-archive-")); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	const makeHandle = (id: string) => ({
		sessionId: id,
		sessionName: `name-${id}`,
		agentName: "test-agent",
		cwd: "/tmp",
		createdAt: new Date("2026-01-01"),
		lastActivityAt: new Date("2026-01-01"),
		lastResponseAt: undefined as Date | undefined,
		completedAt: undefined as Date | undefined,
		disposed: false,
		autoClosed: undefined as boolean | undefined,
		closeReason: undefined as string | undefined,
		model: undefined as string | undefined,
		mode: undefined as string | undefined,
	});

	it("stores and retrieves a session", () => {
		const store = new SessionArchiveStore(tmpDir, "ses-test-1");
		const handle = makeHandle("s1");
		const archived = store.upsert(handle);
		expect(archived.sessionId).toBe("s1");
		expect(store.get("s1")).toBeDefined();
	});

	it("returns undefined for unknown session", () => {
		const store = new SessionArchiveStore(tmpDir, "ses-test-1");
		expect(store.get("unknown")).toBeUndefined();
	});

	it("updates existing session", () => {
		const store = new SessionArchiveStore(tmpDir, "ses-test-1");
		store.upsert(makeHandle("s1"));
		const updated = { ...makeHandle("s1"), disposed: true, closeReason: "stale" };
		store.upsert(updated);
		const retrieved = store.get("s1");
		expect(retrieved!.disposed).toBe(true);
		expect(retrieved!.closeReason).toBe("stale");
	});

	it("persists across store instances", () => {
		const store1 = new SessionArchiveStore(tmpDir, "ses-test-1");
		store1.upsert(makeHandle("s1"));
		const store2 = new SessionArchiveStore(tmpDir, "ses-test-1");
		expect(store2.get("s1")).toBeDefined();
	});
});

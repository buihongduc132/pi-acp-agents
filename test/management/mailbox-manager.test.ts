import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MailboxManager } from "../../src/management/mailbox-manager.js";

describe("MailboxManager", () => {
	let tmpDir: string;
	let mm: MailboxManager;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-mailbox-"));
		mm = new MailboxManager(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("send", () => {
		it("creates a message with correct fields", () => {
			const mail = mm.send({ from: "alice", to: "bob", message: "hi", kind: "dm" });
			expect(mail.id).toBe("1");
			expect(mail.from).toBe("alice");
			expect(mail.to).toBe("bob");
			expect(mail.message).toBe("hi");
			expect(mail.kind).toBe("dm");
			expect(mail.createdAt).toBeDefined();
			expect(mail.readAt).toBeUndefined();
		});

		it("auto-increments id", () => {
			mm.send({ from: "a", to: "b", message: "1", kind: "dm" });
			const m2 = mm.send({ from: "a", to: "b", message: "2", kind: "dm" });
			expect(m2.id).toBe("2");
		});

		it("persists messages to disk", () => {
			mm.send({ from: "alice", to: "bob", message: "hello", kind: "dm" });
			const mailboxFile = join(tmpDir, "mailboxes.json");
			expect(existsSync(mailboxFile)).toBe(true);
			const data = JSON.parse(readFileSync(mailboxFile, "utf-8"));
			expect(data.messages).toHaveLength(1);
			expect(data.nextId).toBe(2);
		});

		it("supports broadcast messages via wildcard to", () => {
			const mail = mm.send({ from: "system", to: "*", message: "maintenance", kind: "broadcast" });
			expect(mail.to).toBe("*");
			expect(mail.kind).toBe("broadcast");
		});

		it("supports steer kind", () => {
			const mail = mm.send({ from: "user", to: "agent", message: "redirect", kind: "steer" });
			expect(mail.kind).toBe("steer");
		});
	});

	describe("listFor", () => {
		it("returns messages addressed to recipient", () => {
			mm.send({ from: "alice", to: "bob", message: "hi bob", kind: "dm" });
			mm.send({ from: "alice", to: "carol", message: "hi carol", kind: "dm" });
			expect(mm.listFor("bob")).toHaveLength(1);
			expect(mm.listFor("bob")[0].message).toBe("hi bob");
		});

		it("returns broadcast messages for any recipient", () => {
			mm.send({ from: "system", to: "*", message: "broadcast msg", kind: "broadcast" });
			mm.send({ from: "alice", to: "bob", message: "dm only", kind: "dm" });
			// carol should see broadcast but not the DM
			const carolMail = mm.listFor("carol");
			expect(carolMail).toHaveLength(1);
			expect(carolMail[0].message).toBe("broadcast msg");
		});

		it("returns empty array for unknown recipient with no broadcasts", () => {
			mm.send({ from: "alice", to: "bob", message: "private", kind: "dm" });
			expect(mm.listFor("carol")).toHaveLength(0);
		});

		it("returns both direct and broadcast messages", () => {
			mm.send({ from: "system", to: "*", message: "broadcast", kind: "broadcast" });
			mm.send({ from: "alice", to: "bob", message: "direct", kind: "dm" });
			const bobMail = mm.listFor("bob");
			expect(bobMail).toHaveLength(2);
		});
	});

	describe("markRead", () => {
		it("marks a message as read with timestamp", () => {
			const mail = mm.send({ from: "alice", to: "bob", message: "hi", kind: "dm" });
			expect(mail.readAt).toBeUndefined();
			const updated = mm.markRead(mail.id);
			expect(updated.readAt).toBeDefined();
			expect(typeof updated.readAt).toBe("string");
		});

		it("throws if message id not found", () => {
			expect(() => mm.markRead("nonexistent")).toThrow(/not found/);
		});

		it("persists read status to disk", () => {
			const mail = mm.send({ from: "alice", to: "bob", message: "hi", kind: "dm" });
			mm.markRead(mail.id);
			// Create a new manager to verify persistence
			const mm2 = new MailboxManager(tmpDir);
			const msgs = mm2.listFor("bob");
			expect(msgs[0].readAt).toBeDefined();
		});
	});

	describe("clearFor", () => {
		it("removes messages for a specific recipient", () => {
			mm.send({ from: "alice", to: "bob", message: "1", kind: "dm" });
			mm.send({ from: "alice", to: "bob", message: "2", kind: "dm" });
			mm.send({ from: "alice", to: "carol", message: "3", kind: "dm" });
			const removed = mm.clearFor("bob");
			expect(removed).toBe(2);
			expect(mm.listFor("bob")).toHaveLength(0);
			expect(mm.listFor("carol")).toHaveLength(1);
		});

		it("removes broadcast messages when clearing for any recipient", () => {
			mm.send({ from: "system", to: "*", message: "broadcast", kind: "broadcast" });
			const removed = mm.clearFor("anyone");
			expect(removed).toBe(1);
		});

		it("returns 0 when no messages to remove", () => {
			mm.send({ from: "alice", to: "bob", message: "hi", kind: "dm" });
			const removed = mm.clearFor("carol");
			expect(removed).toBe(0);
		});
	});

	describe("edge cases", () => {
		it("handles corrupted mailbox file gracefully", () => {
			const { writeFileSync } = require("node:fs");
			writeFileSync(join(tmpDir, "mailboxes.json"), "not json {{{");
			// Should return empty results
			expect(mm.listFor("bob")).toHaveLength(0);
		});

		it("handles missing mailbox file gracefully", () => {
			expect(mm.listFor("bob")).toHaveLength(0);
		});

		it("handles multiple send and clear cycles", () => {
			mm.send({ from: "a", to: "b", message: "1", kind: "dm" });
			mm.send({ from: "a", to: "b", message: "2", kind: "dm" });
			mm.clearFor("b");
			mm.send({ from: "a", to: "b", message: "3", kind: "dm" });
			const msgs = mm.listFor("b");
			expect(msgs).toHaveLength(1);
			expect(msgs[0].message).toBe("3");
		});
	});
});

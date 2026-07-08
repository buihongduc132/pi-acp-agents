/**
 * RED tests for src/hooks/socket-bus.ts — SocketPublisher + SocketSubscriber
 *
 * Source does NOT exist yet. These tests MUST FAIL (RED phase of TDD).
 * Spec: flow/plans/acp-hooks-impl-spec.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";

// Source module does not exist yet — import will fail (RED)
import { SocketPublisher, SocketSubscriber } from "../../src/hooks/socket-bus.js";
import type { SocketEvent } from "../../src/hooks/types.js";

describe("socket-bus", () => {
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-sock-"));
    sockPath = join(tmpDir, "events.sock");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── SG1: Stale socket cleanup ──────────────────────────────────────────
  describe("SG1 — stale socket cleanup", () => {
    it("unlinks existing socket file before bind()", async () => {
      // Pre-create a stale socket file
      writeFileSync(sockPath, "stale");
      expect(existsSync(sockPath)).toBe(true);

      const publisher = new SocketPublisher({ path: sockPath });
      await publisher.start();

      // The stale file should have been removed and replaced with a real socket
      expect(existsSync(sockPath)).toBe(true);
      const stat = statSync(sockPath);
      // Socket file should be a socket, not a regular file
      expect(stat.isSocket()).toBe(true);

      await publisher.stop();
    });

    it("creates a PID file at <socket-path>.pid", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      await publisher.start();

      const pidPath = sockPath + ".pid";
      expect(existsSync(pidPath)).toBe(true);
      const pidContent = readFileSync(pidPath, "utf-8");
      expect(Number(pidContent)).toBe(process.pid);

      await publisher.stop();
    });

    it("sets socket file permissions to 0600", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      await publisher.start();

      const stat = statSync(sockPath);
      // Mask to permission bits only
      const perms = stat.mode & 0o777;
      expect(perms).toBe(0o600);

      await publisher.stop();
    });
  });

  // ── JSON Lines protocol ────────────────────────────────────────────────
  describe("JSON Lines protocol", () => {
    it("publishes an event and subscriber receives parsed JSON", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      const subscriber = new SocketSubscriber({ path: sockPath });

      await publisher.start();

      const received: SocketEvent[] = [];
      subscriber.on("event", (evt: SocketEvent) => {
        received.push(evt);
      });
      await subscriber.start();

      const event: SocketEvent = {
        "event-type": "acp.task_completed",
        "event-id": "evt-001",
        timestamp: new Date().toISOString(),
        source: "acp",
        payload: {
          version: 1,
          event: "task_completed",
          source: "acp",
          correlationId: "corr-001",
          session: { id: "sess-1", agent: "pi", cwd: "/tmp" },
          agent: { name: "pi", type: "coding" },
          task: { id: "t-1", subject: "test", status: "completed" },
          timestamp: new Date().toISOString(),
        },
      };

      await publisher.publish(event);

      // Give it a tick to deliver
      await new Promise((r) => setTimeout(r, 100));

      expect(received).toHaveLength(1);
      expect(received[0]["event-type"]).toBe("acp.task_completed");
      expect(received[0]["event-id"]).toBe("evt-001");

      await subscriber.stop();
      await publisher.stop();
    });
  });

  // ── LD5: Malformed message isolation ───────────────────────────────────
  describe("LD5 — malformed message isolation", () => {
    it("skips bad JSON lines and processes the next valid line", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      const subscriber = new SocketSubscriber({ path: sockPath });

      await publisher.start();

      const received: SocketEvent[] = [];
      subscriber.on("event", (evt: SocketEvent) => {
        received.push(evt);
      });
      await subscriber.start();

      // Publish a valid event, then simulate a malformed write via raw socket
      const goodEvent: SocketEvent = {
        "event-type": "acp.session_started",
        "event-id": "evt-good",
        timestamp: new Date().toISOString(),
        source: "acp",
        payload: {
          version: 1,
          event: "session_started",
          source: "acp",
          correlationId: "corr-good",
          session: { id: "s1", agent: "pi", cwd: "/tmp" },
          agent: { name: "pi", type: "coding" },
          timestamp: new Date().toISOString(),
        },
      };

      await publisher.publish(goodEvent);

      // Write malformed data directly to the socket
      const rawClient = createConnection(sockPath);
      await new Promise<void>((resolve) => rawClient.on("connect", resolve));
      rawClient.write("this is not json\n");
      await new Promise((r) => setTimeout(r, 50));

      // Publish another good event after the malformed one
      const goodEvent2: SocketEvent = {
        ...goodEvent,
        "event-id": "evt-good-2",
        "event-type": "acp.task_completed",
      };
      await publisher.publish(goodEvent2);

      await new Promise((r) => setTimeout(r, 100));

      // Should have received 2 good events, malformed one skipped
      expect(received).toHaveLength(2);
      expect(received[0]["event-id"]).toBe("evt-good");
      expect(received[1]["event-id"]).toBe("evt-good-2");

      rawClient.destroy();
      await subscriber.stop();
      await publisher.stop();
    });
  });

  // ── LD12: Oversized message drop ───────────────────────────────────────
  describe("LD12 — oversized message drop", () => {
    it("drops messages exceeding maxMessageSize without truncation", async () => {
      const maxMsgSize = 1024; // Small limit for testing
      const publisher = new SocketPublisher({
        path: sockPath,
        maxMessageSize: maxMsgSize,
      });
      const subscriber = new SocketSubscriber({ path: sockPath });

      await publisher.start();

      const received: SocketEvent[] = [];
      subscriber.on("event", (evt: SocketEvent) => {
        received.push(evt);
      });
      await subscriber.start();

      // Create an oversized event
      const oversizedEvent: SocketEvent = {
        "event-type": "acp.task_completed",
        "event-id": "evt-huge",
        timestamp: new Date().toISOString(),
        source: "acp",
        payload: {
          version: 1,
          event: "task_completed",
          source: "acp",
          correlationId: "corr-huge",
          session: { id: "s1", agent: "pi", cwd: "/tmp" },
          agent: { name: "pi", type: "coding" },
          task: {
            id: "t-huge",
            subject: "x".repeat(maxMsgSize + 500), // Exceeds limit
            status: "completed",
            result: "y".repeat(maxMsgSize),
          },
          timestamp: new Date().toISOString(),
        },
      };

      // publish should either throw or silently drop — not truncate
      try {
        await publisher.publish(oversizedEvent);
      } catch {
        // Expected: may throw on oversized
      }

      await new Promise((r) => setTimeout(r, 100));

      // The oversized message must NOT appear in received events
      const hugeReceived = received.find((e) => e["event-id"] === "evt-huge");
      expect(hugeReceived).toBeUndefined();

      await subscriber.stop();
      await publisher.stop();
    });
  });

  // ── SG3: Ring-buffer backpressure ──────────────────────────────────────
  describe("SG3 — ring-buffer backpressure", () => {
    it("drops oldest non-critical events when buffer is full", async () => {
      const publisher = new SocketPublisher({
        path: sockPath,
        ringBufferSize: 5,
      });
      await publisher.start();

      // Publish 7 non-critical events (no subscriber consuming)
      for (let i = 0; i < 7; i++) {
        await publisher.publish({
          "event-type": "acp.session_idle",
          "event-id": `evt-${i}`,
          timestamp: new Date().toISOString(),
          source: "acp",
          payload: {
            version: 1,
            event: "session_idle",
            source: "acp",
            correlationId: `corr-${i}`,
            session: { id: "s1", agent: "pi", cwd: "/tmp" },
            agent: { name: "pi", type: "coding" },
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Buffer should have dropped oldest 2 (only 5 remain)
      const buffered = publisher.getBufferedEvents();
      expect(buffered.length).toBeLessThanOrEqual(5);
      // First remaining should be evt-2 (evt-0 and evt-1 dropped)
      expect(buffered[0]["event-id"]).toBe("evt-2");

      await publisher.stop();
    });

    it("NEVER drops completion events even when buffer is full", async () => {
      const publisher = new SocketPublisher({
        path: sockPath,
        ringBufferSize: 3,
      });
      await publisher.start();

      // Fill buffer with non-critical events
      for (let i = 0; i < 3; i++) {
        await publisher.publish({
          "event-type": "acp.session_idle",
          "event-id": `idle-${i}`,
          timestamp: new Date().toISOString(),
          source: "acp",
          payload: {
            version: 1,
            event: "session_idle",
            source: "acp",
            correlationId: `corr-idle-${i}`,
            session: { id: "s1", agent: "pi", cwd: "/tmp" },
            agent: { name: "pi", type: "coding" },
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Now publish completion events — these must NEVER be dropped
      await publisher.publish({
        "event-type": "acp.task_completed",
        "event-id": "completion-1",
        timestamp: new Date().toISOString(),
        source: "acp",
        payload: {
          version: 1,
          event: "task_completed",
          source: "acp",
          correlationId: "corr-comp-1",
          session: { id: "s1", agent: "pi", cwd: "/tmp" },
          agent: { name: "pi", type: "coding" },
          task: { id: "t1", subject: "test", status: "completed" },
          timestamp: new Date().toISOString(),
        },
      });

      const buffered = publisher.getBufferedEvents();
      const completionEvents = buffered.filter(
        (e: SocketEvent) => e["event-id"] === "completion-1"
      );
      expect(completionEvents).toHaveLength(1);

      await publisher.stop();
    });
  });

  // ── SG2: Single consumer v1 ────────────────────────────────────────────
  describe("SG2 — single consumer v1", () => {
    it("rejects second connection (documented limitation)", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      await publisher.start();

      // First subscriber connects successfully
      const sub1 = new SocketSubscriber({ path: sockPath });
      await sub1.start();

      // Second subscriber should be rejected or its connection closed
      const sub2 = new SocketSubscriber({ path: sockPath });
      let sub2Error: Error | null = null;
      try {
        await sub2.start();
      } catch (err: any) {
        sub2Error = err;
      }

      // Either sub2 fails to connect, or it gets disconnected
      // The key assertion: only one consumer is active
      const activeConsumers = publisher.getActiveConsumerCount();
      expect(activeConsumers).toBeLessThanOrEqual(1);

      // sub2 should either have thrown or been disconnected
      if (!sub2Error) {
        // If it connected, it should have been closed/rejected
        await new Promise((r) => setTimeout(r, 100));
        expect(sub2.isConnected()).toBe(false);
      }

      await sub1.stop();
      try { await sub2.stop(); } catch { /* may already be dead */ }
      await publisher.stop();
    });
  });

  // ── LD15: SO_PEERCRED auth ─────────────────────────────────────────────
  describe("LD15 — SO_PEERCRED auth", () => {
    it("rejects connections from different UID (mocked)", async () => {
      // We can't actually change UID, so we mock the peercred check
      const publisher = new SocketPublisher({
        path: sockPath,
        // Inject a mock peer credential checker that returns a different UID
        peerCredentialChecker: vi.fn().mockReturnValue({ uid: 99999, gid: 99999, pid: 1 }),
      });
      await publisher.start();

      // AF_UNIX platform limitation: a server-side destroy() of an idle
      // accepted socket surfaces to the peer as 'close'/'end', NOT 'error'
      // (no RST on AF_UNIX in Node's net module). The connection IS
      // correctly torn down by rejectConnection(); we observe it via either
      // event. See src/hooks/socket-bus.ts rejectConnection() note.
      let connectionRejected = false;
      const markRejected = () => {
        connectionRejected = true;
      };
      const rawClient = createConnection(sockPath);
      rawClient.on("error", markRejected);
      rawClient.on("close", markRejected);

      await new Promise((r) => setTimeout(r, 200));
      expect(connectionRejected).toBe(true);

      rawClient.destroy();
      await publisher.stop();
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────
  describe("lifecycle", () => {
    it("publisher start creates socket, stop removes it", async () => {
      const publisher = new SocketPublisher({ path: sockPath });

      await publisher.start();
      expect(existsSync(sockPath)).toBe(true);

      await publisher.stop();
      expect(existsSync(sockPath)).toBe(false);
    });

    it("subscriber connects to publisher and disconnects on stop", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      const subscriber = new SocketSubscriber({ path: sockPath });

      await publisher.start();
      await subscriber.start();
      expect(subscriber.isConnected()).toBe(true);

      await subscriber.stop();
      expect(subscriber.isConnected()).toBe(false);

      await publisher.stop();
    });

    it("cleans up PID file on stop", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      await publisher.start();

      const pidPath = sockPath + ".pid";
      expect(existsSync(pidPath)).toBe(true);

      await publisher.stop();
      expect(existsSync(pidPath)).toBe(false);
    });

    it("is idempotent — double stop does not throw", async () => {
      const publisher = new SocketPublisher({ path: sockPath });
      await publisher.start();
      await publisher.stop();

      // Second stop should not throw
      await expect(publisher.stop()).resolves.not.toThrow();
    });
  });
});

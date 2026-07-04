import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/config/config.js";

/**
 * RED phase for OpenSpec change `agent-profile-description` section 2.
 *
 * Rule under test (NOT yet implemented — these tests are expected to FAIL):
 *   An agent MAY declare an OPTIONAL `description?: string`.
 *   If `description` is present it MUST be a string. Any non-string value
 *   (number / object / array / null) must throw an error whose message
 *   NAMES the offending agent, e.g.
 *       description must be a string on agent "<name>"
 *   Absent / undefined = OK (no throw). No length cap.
 *
 * Each agent below uses `command: "echo"` so it clears the existing
 * command-required check; the only thing being exercised is the new
 * description validation.
 */
describe("validateConfig — agent description validation (RED)", () => {
  describe("accepts valid description", () => {
    it("passes the description through when it is a string", () => {
      const result = validateConfig({
        agent_servers: { botwithdesc: { command: "echo", description: "the desc" } },
      } as any);
      expect(result.agent_servers.botwithdesc.description).toBe("the desc");
    });

    it("omits description (undefined) and the agent remains spawnable (no throw)", () => {
      const result = validateConfig({
        agent_servers: { botnodesc: { command: "echo" } },
      } as any);
      expect(result.agent_servers.botnodesc.description).toBeUndefined();
      // spawnable = no throw above; sanity check command preserved
      expect(result.agent_servers.botnodesc.command).toBe("echo");
    });
  });

  describe("rejects non-string description", () => {
    it("throws when description is a number (123)", () => {
      expect(() =>
        validateConfig({
          agent_servers: { mybot: { command: "echo", description: 123 } },
        } as any),
      ).toThrow(/description must be a string/i);
      // Error must NAME the offending agent.
      expect(() =>
        validateConfig({
          agent_servers: { mybot: { command: "echo", description: 123 } },
        } as any),
      ).toThrow(/agent "mybot"/i);
    });

    it("throws when description is an object ({x:1})", () => {
      expect(() =>
        validateConfig({
          agent_servers: { objbot: { command: "echo", description: { x: 1 } } },
        } as any),
      ).toThrow(/description must be a string/i);
    });

    it("throws when description is an array (['a'])", () => {
      expect(() =>
        validateConfig({
          agent_servers: { arrbot: { command: "echo", description: ["a"] } },
        } as any),
      ).toThrow(/description must be a string/i);
    });

    it("throws when description is null (null is not undefined)", () => {
      expect(() =>
        validateConfig({
          agent_servers: { nullbot: { command: "echo", description: null } },
        } as any),
      ).toThrow(/description must be a string/i);
    });
  });

  describe("error names the offending agent specifically", () => {
    it("with two agents (one valid, one invalid) names the invalid one", () => {
      expect(() =>
        validateConfig({
          agent_servers: {
            goodbot: { command: "echo", description: "fine" },
            badbot: { command: "echo", description: 999 },
          },
        } as any),
      ).toThrow(/description must be a string on agent "badbot"/i);
    });
  });
});

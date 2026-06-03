/**
 * Tests for ACP protocol behavior validation
 */
import { describe, it, expect } from "vitest";
import {
	AcpProtocolError,
	validateInitializeResponse,
	validateNewSessionResponse,
	validatePromptResponse,
	classifyConnectionError,
} from "../src/core/protocol-validator.js";

describe("AcpProtocolError", () => {
	it("has correct shape and message", () => {
		const err = new AcpProtocolError({
			agentName: "test-agent",
			command: "test-cmd",
			phase: "initialize",
			message: "Missing field",
			cause: "No protocolVersion",
		});
		expect(err.name).toBe("AcpProtocolError");
		expect(err.agentName).toBe("test-agent");
		expect(err.command).toBe("test-cmd");
		expect(err.phase).toBe("initialize");
		expect(err.message).toContain("ACP Protocol Mismatch");
		expect(err.message).toContain("test-agent");
		expect(err.message).toContain("test-cmd");
		expect(err.message).toContain("initialize");
		expect(err.message).toContain("verify the command speaks ACP");
	});
});

describe("validateInitializeResponse", () => {
	it("accepts valid ACP initialize response", () => {
		const resp = {
			protocolVersion: "2025-01-01",
			capabilities: {},
			serverInfo: { name: "test", version: "1.0" },
		};
		expect(() => validateInitializeResponse(resp, "a", "cmd")).not.toThrow();
	});

	it("rejects null response", () => {
		expect(() => validateInitializeResponse(null, "a", "cmd")).toThrow(AcpProtocolError);
	});

	it("rejects non-object response", () => {
		expect(() => validateInitializeResponse("hello", "a", "cmd")).toThrow(AcpProtocolError);
	});

	it("rejects response missing protocolVersion", () => {
		const resp = { capabilities: {}, serverInfo: { name: "x", version: "1" } };
		expect(() => validateInitializeResponse(resp, "a", "cmd")).toThrow(/protocolVersion/);
	});

	it("rejects response missing capabilities", () => {
		// agentCapabilities is optional — only protocolVersion is required
		const resp = { protocolVersion: "1", agentInfo: { name: "x", version: "1" } };
		expect(() => validateInitializeResponse(resp, "a", "cmd")).not.toThrow();
	});

	it("rejects response missing serverInfo", () => {
		// agentInfo is optional — only protocolVersion is required
		const resp = { protocolVersion: "1" };
		expect(() => validateInitializeResponse(resp, "a", "cmd")).not.toThrow();
	});
});

describe("validateNewSessionResponse", () => {
	it("accepts valid newSession response", () => {
		const resp = { sessionId: "ses_abc123" };
		expect(() => validateNewSessionResponse(resp, "a", "cmd")).not.toThrow();
	});

	it("rejects null response", () => {
		expect(() => validateNewSessionResponse(null, "a", "cmd")).toThrow(AcpProtocolError);
	});

	it("rejects response missing sessionId", () => {
		const resp = { id: "something" };
		expect(() => validateNewSessionResponse(resp, "a", "cmd")).toThrow(/sessionId/);
	});

	it("rejects empty sessionId", () => {
		const resp = { sessionId: "" };
		expect(() => validateNewSessionResponse(resp, "a", "cmd")).toThrow(/sessionId/);
	});

	it("rejects non-string sessionId", () => {
		const resp = { sessionId: 123 };
		expect(() => validateNewSessionResponse(resp, "a", "cmd")).toThrow(/sessionId/);
	});
});

describe("validatePromptResponse", () => {
	it("accepts valid prompt response", () => {
		const resp = { stopReason: "end_turn" };
		expect(() => validatePromptResponse(resp, "a", "cmd")).not.toThrow();
	});

	it("rejects null response", () => {
		expect(() => validatePromptResponse(null, "a", "cmd")).toThrow(AcpProtocolError);
	});

	it("rejects response missing stopReason", () => {
		const resp = { text: "hello" };
		expect(() => validatePromptResponse(resp, "a", "cmd")).toThrow(/stopReason/);
	});
});

describe("classifyConnectionError", () => {
	it("passes through AcpProtocolError as-is", () => {
		const orig = new AcpProtocolError({
			agentName: "a", command: "c", phase: "spawn", message: "x", cause: "y",
		});
		const result = classifyConnectionError(orig, "a", "c");
		expect(result).toBe(orig);
	});

	it("classifies ENOENT as protocol error", () => {
		const err = new Error("spawn my-cmd ENOENT");
		const result = classifyConnectionError(err, "agent", "my-cmd");
		expect(result).toBeInstanceOf(AcpProtocolError);
		expect((result as AcpProtocolError).phase).toBe("spawn");
	});

	it("classifies JSON parse errors as protocol error", () => {
		const err = new Error("Unexpected token in JSON at position 0");
		const result = classifyConnectionError(err, "agent", "cmd");
		expect(result).toBeInstanceOf(AcpProtocolError);
		expect((result as AcpProtocolError).phase).toBe("connect");
	});

	it("classifies Method not found as protocol error", () => {
		const err = new Error("Method not found: initialize (-32601)");
		const result = classifyConnectionError(err, "agent", "cmd");
		expect(result).toBeInstanceOf(AcpProtocolError);
		expect((result as AcpProtocolError).phase).toBe("initialize");
	});

	it("classifies timeout as protocol error", () => {
		const err = new Error("Request timed out after 30000ms");
		const result = classifyConnectionError(err, "agent", "cmd");
		expect(result).toBeInstanceOf(AcpProtocolError);
	});

	it("passes through auth errors as-is", () => {
		const err = new Error("Authentication required (401)");
		const result = classifyConnectionError(err, "agent", "cmd");
		expect(result).not.toBeInstanceOf(AcpProtocolError);
	});

	it("passes through unknown errors as-is", () => {
		const err = new Error("Some random error");
		const result = classifyConnectionError(err, "agent", "cmd");
		expect(result).not.toBeInstanceOf(AcpProtocolError);
	});

	it("includes stderr in classified errors", () => {
		const err = new Error("spawn my-cmd ENOENT");
		const result = classifyConnectionError(err, "agent", "cmd", "some stderr output");
		expect(result.message).toContain("some stderr output");
	});
});

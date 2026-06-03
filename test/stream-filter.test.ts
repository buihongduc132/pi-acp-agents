/**
 * Tests for the stdout JSON-line filter in client.ts
 *
 * Verifies that non-JSON lines (stack traces, MCP errors) are filtered
 * before reaching ndJsonStream, preventing "Failed to parse JSON message" noise.
 */
import { describe, it, expect } from "vitest";
import { TextEncoder, TextDecoder } from "node:util";

// Inline the filter function for unit testing (mirrors client.ts createFilteredStdoutStream)
function createFilteredStdoutStream(
	rawStdout: ReadableStream<Uint8Array>,
	logged: string[],
): ReadableStream<Uint8Array> {
	const textDecoder = new TextDecoder();
	const textEncoder = new TextEncoder();
	let buffer = "";

	function isJsonLine(line: string): boolean {
		const trimmed = line.trim();
		if (!trimmed) return false;
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
		try {
			JSON.parse(trimmed);
			return true;
		} catch {
			return false;
		}
	}

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = rawStdout.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) {
						if (buffer.trim()) {
							const line = buffer.trim();
							if (isJsonLine(line)) {
								controller.enqueue(textEncoder.encode(line + "\n"));
							} else {
								logged.push(line.slice(0, 200));
							}
						}
						break;
					}
					if (!value) continue;
					buffer += textDecoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						if (isJsonLine(trimmed)) {
							controller.enqueue(textEncoder.encode(line + "\n"));
						} else {
							logged.push(trimmed.slice(0, 200));
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
			controller.close();
		},
	});
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

async function collectFiltered(
	chunks: string[],
): Promise<{ passed: string[]; logged: string[] }> {
	const logged: string[] = [];
	const stream = createFilteredStdoutStream(makeStream(chunks), logged);
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const passed: string[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) passed.push(decoder.decode(value));
	}
	return { passed, logged };
}

describe("stdout JSON-line filter", () => {
	it("passes valid JSON objects through", async () => {
		const { passed, logged } = await collectFiltered([
			'{"type":"response","text":"hello"}\n',
		]);
		expect(passed).toHaveLength(1);
		expect(passed[0]).toContain('"type":"response"');
		expect(logged).toHaveLength(0);
	});

	it("passes valid JSON arrays through", async () => {
		const { passed, logged } = await collectFiltered(["[1,2,3]\n"]);
		expect(passed).toHaveLength(1);
		expect(passed[0]).toContain("[1,2,3]");
		expect(logged).toHaveLength(0);
	});

	it("filters out stack trace lines", async () => {
		const { passed, logged } = await collectFiltered([
			"at processStream (file:///some/path/bundle.js:123:45)\n",
		]);
		expect(passed).toHaveLength(0);
		expect(logged.length).toBeGreaterThan(0);
		expect(logged[0]).toContain("at processStream");
	});

	it("filters out MCP error lines", async () => {
		const { passed, logged } = await collectFiltered([
			"[MCP error] MCP ERROR (hindsight) Error: SSE stream disconnected\n",
		]);
		expect(passed).toHaveLength(0);
		expect(logged[0]).toContain("[MCP error]");
	});

	it("filters out leading-whitespace lines", async () => {
		const { passed, logged } = await collectFiltered([
			"    at process.processTicksAndRejections\n",
		]);
		expect(passed).toHaveLength(0);
		expect(logged[0]).toContain("processTicksAndRejections");
	});

	it("handles mixed JSON and non-JSON in same chunk", async () => {
		const input = [
			'{"jsonrpc":"2.0","method":"notify"}\n',
			"at some.stack.trace\n",
			'{"jsonrpc":"2.0","result":"ok"}\n',
			"[MCP error] something broke\n",
		].join("");
		const { passed, logged } = await collectFiltered([input]);
		expect(passed).toHaveLength(2);
		expect(logged).toHaveLength(2);
	});

	it("handles incomplete lines across chunks", async () => {
		const { passed, logged } = await collectFiltered([
			'{"jsonrpc":"2.0","meth', // incomplete
			'od":"update"}\n', // completes the line
			"some error text\n",
		]);
		expect(passed).toHaveLength(1);
		expect(passed[0]).toContain('"jsonrpc"');
		expect(logged).toHaveLength(1);
	});

	it("handles empty stream", async () => {
		const { passed, logged } = await collectFiltered([]);
		expect(passed).toHaveLength(0);
		expect(logged).toHaveLength(0);
	});

	it("handles blank lines", async () => {
		const { passed, logged } = await collectFiltered([
			'\n\n{"ok":true}\n\n\n',
		]);
		expect(passed).toHaveLength(1);
		expect(logged).toHaveLength(0);
	});
});

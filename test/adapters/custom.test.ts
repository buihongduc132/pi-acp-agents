import { describe, it, expect } from "vitest";
import { CustomAcpAdapter } from "../../src/adapters/custom.js";

describe("CustomAcpAdapter", () => {
	it("returns name 'custom'", () => {
		const adapter = new CustomAcpAdapter({
			config: { command: "my-agent", args: ["--flag"] },
		});
		expect(adapter.name).toBe("custom");
	});

	it("passes through config", () => {
		const adapter = new CustomAcpAdapter({
			config: { command: "my-agent", args: ["--flag"] },
		});
		expect(adapter["config"].command).toBe("my-agent");
		expect(adapter["config"].args).toEqual(["--flag"]);
	});
});

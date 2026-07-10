import { describe, it, expect } from "vitest";
import {
	ACP_TOOL_NAMES,
	DEFAULT_SETTINGS,
	type AcpToolName,
} from "../../src/settings/config.js";

describe("DAG tool names registered in settings — task 1.4", () => {
	it("ACP_TOOL_NAMES includes the 3 DAG tools", () => {
		expect(ACP_TOOL_NAMES).toContain("acp_dag_submit");
		expect(ACP_TOOL_NAMES).toContain("acp_dag_status");
		expect(ACP_TOOL_NAMES).toContain("acp_dag_cancel");
	});

	it("DEFAULT_SETTINGS enables all 3 DAG tools", () => {
		const dagTools: AcpToolName[] = [
			"acp_dag_submit",
			"acp_dag_status",
			"acp_dag_cancel",
		];
		for (const name of dagTools) {
			expect(DEFAULT_SETTINGS.tools[name]).toBeDefined();
			expect(DEFAULT_SETTINGS.tools[name].enabled).toBe(true);
		}
	});

	it("ACP_TOOL_NAMES includes DAG tools after consolidation", () => {
		// ACP_TOOL_NAMES includes legacy + unified names; just verify DAG tools present
		expect(ACP_TOOL_NAMES).toContain("acp_dag");
		expect(ACP_TOOL_NAMES.length).toBeGreaterThanOrEqual(42);
	});
});

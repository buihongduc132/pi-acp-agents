/**
 * Task 1.2 — `AcpWidgetState` SHALL include optional `dags?: AcpWidgetDag[]`.
 *
 * Verifies both the type-level presence of the field and that a state value
 * carrying DAGs can be constructed and inspected at runtime.
 */
import { describe, it, expect } from "vitest";
import type { AcpWidgetState, AcpWidgetDag } from "../src/acp-widget.js";

// Type-level assertion: `dags` must be an optional key of AcpWidgetState.
type HasDags = "dags" extends keyof AcpWidgetState ? true : false;
const _typeCheck: HasDags = true;
void _typeCheck;

function makeDag(overrides: Partial<AcpWidgetDag> = {}): AcpWidgetDag {
	return {
		dagId: "abc",
		status: "running",
		total: 5,
		completed: 2,
		failed: 1,
		cancelled: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

describe("AcpWidgetState.dags (task 1.2)", () => {
	it("constructs a state with a non-empty dags array", () => {
		const state: AcpWidgetState = {
			sessions: [],
			circuitBreakerState: "closed",
			configuredAgentNames: [],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
			},
			dags: [makeDag({ dagId: "run-1" }), makeDag({ dagId: "run-2" })],
		};

		expect(state.dags).toBeDefined();
		expect(state.dags).toHaveLength(2);
		expect(state.dags![0].dagId).toBe("run-1");
		expect(state.dags![1].dagId).toBe("run-2");
	});

	it("allows omitting the optional dags field entirely", () => {
		const state: AcpWidgetState = {
			sessions: [],
			circuitBreakerState: "closed",
			configuredAgentNames: [],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
			},
		};

		expect(state.dags).toBeUndefined();
	});

	it("accepts an empty dags array", () => {
		const state: AcpWidgetState = {
			sessions: [],
			circuitBreakerState: "closed",
			configuredAgentNames: [],
			activity: {
				activeDelegations: 0,
				activeBroadcasts: 0,
				activeCompares: 0,
				delegations: [],
			},
			dags: [],
		};

		expect(state.dags).toEqual([]);
	});
});

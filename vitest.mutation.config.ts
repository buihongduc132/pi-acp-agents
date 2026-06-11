/**
 * Vitest config for Stryker mutation testing.
 *
 * Differences from vitest.config.ts:
 * - Explicitly excludes dist/ to prevent compiled .js test bleed
 * - Uses only .ts test files from test/
 * - Disables coverage (Stryker handles mutation coverage)
 * - Higher timeout for mutation runs
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: [
			"dist/**",
			"node_modules/**",
			".git/**",
			".stryker-tmp/**",
		],
		// No coverage provider — Stryker measures mutation coverage
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});

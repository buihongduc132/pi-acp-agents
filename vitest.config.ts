import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "index.ts"],
			exclude: ["src/config/types.ts"],
			reporter: ["text", "lcov"],
			reportsDirectory: "./coverage",
		},
	},
});

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Pure unit tests: milliseconds, no network, no ports. CI always runs these.
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		// Test files must not overlap: build-pipeline.test.ts runs the builder, which
		// writes the compiled artifacts that english-only.test.ts scans.
		fileParallelism: false,
	},
});

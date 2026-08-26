import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "**/*.perf.test.ts",
      "**/*.security.test.ts",
    ],
    include: ["{apps,packages,tests}/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
  },
});

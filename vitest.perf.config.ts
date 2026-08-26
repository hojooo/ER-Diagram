import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    include: ["{apps,packages}/**/*.perf.test.{ts,tsx}", "test/**/*.perf.test.{ts,tsx}"],
    testTimeout: 15_000,
  },
});

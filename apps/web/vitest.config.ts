import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/*.perf.test.{ts,tsx}"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});

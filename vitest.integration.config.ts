import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    include: [
      "{apps,packages}/**/*.integration.test.{ts,tsx}",
      "test/**/*.integration.test.{ts,tsx}",
    ],
  },
});

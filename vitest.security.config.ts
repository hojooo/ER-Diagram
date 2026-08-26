import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    include: ["{apps,packages}/**/*.security.test.{ts,tsx}", "test/**/*.security.test.{ts,tsx}"],
  },
});

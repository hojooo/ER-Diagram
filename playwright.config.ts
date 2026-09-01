import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  testIgnore: "csp-security.spec.ts",
  fullyParallel: true,
  // Each workspace test loads an independent Monaco, DBML parser, and/or ELK worker graph.
  // Serial execution keeps product timeouts meaningful instead of measuring runner contention.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
  },
  webServer: {
    command: "pnpm --filter @er-diagram/web dev --host 127.0.0.1 --port 4173",
    reuseExistingServer: !process.env.CI,
    url: "http://127.0.0.1:4173",
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: true,
  // The layout spike and source workspace each load an independent heavyweight worker graph.
  // Serial CI execution keeps their route-level timing checks isolated from runner contention.
  workers: process.env.CI ? 1 : undefined,
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

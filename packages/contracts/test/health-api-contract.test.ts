import { describe, expect, it } from "vitest";

import { healthLiveResponseSchema, healthReadyResponseSchema } from "../src/index.js";

const cloneStructured = (globalThis as unknown as { structuredClone<T>(value: T): T })
  .structuredClone;

describe("production health response contracts", () => {
  it("keeps liveness and readiness as strict plain-data responses", () => {
    const live = healthLiveResponseSchema.parse({ status: "ok" });
    const ready = healthReadyResponseSchema.parse({ status: "ready" });

    expect(JSON.parse(JSON.stringify(live))).toEqual(live);
    expect(JSON.parse(JSON.stringify(ready))).toEqual(ready);
    expect(cloneStructured(live)).toEqual(live);
    expect(cloneStructured(ready)).toEqual(ready);
    expect(healthLiveResponseSchema.safeParse({ ...live, storage: "ok" }).success).toBe(false);
    expect(healthReadyResponseSchema.safeParse({ ...ready, version: 2 }).success).toBe(false);
  });

  it("does not conflate live and ready states", () => {
    expect(healthLiveResponseSchema.safeParse({ status: "ready" }).success).toBe(false);
    expect(healthReadyResponseSchema.safeParse({ status: "ok" }).success).toBe(false);
  });
});

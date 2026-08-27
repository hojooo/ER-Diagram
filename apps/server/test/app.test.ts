import type { ProjectApplication } from "@er-diagram/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

const servers = [] as ReturnType<typeof createServer>[];
const unusedProjectApplication = {} as ProjectApplication;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Fastify adapter bootstrap", () => {
  it("exposes a liveness endpoint without leaking Fastify into core", async () => {
    const server = createServer({ projectApplication: unusedProjectApplication });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

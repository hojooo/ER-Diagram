import type {
  LayoutApplication,
  ProjectApplication,
  ProjectBundleApplication,
  SqlExportApplication,
  SqlImportApplication,
  VisualCommandApplication,
} from "@er-diagram/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

const servers = [] as ReturnType<typeof createServer>[];
const unusedProjectApplication = {} as ProjectApplication;
const unusedLayoutApplication = {} as LayoutApplication;
const unusedSqlImportApplication = {} as SqlImportApplication;
const unusedSqlExportApplication = {} as SqlExportApplication;
const unusedVisualCommandApplication = {} as VisualCommandApplication;
const unusedProjectBundleApplication = {} as ProjectBundleApplication;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Fastify adapter bootstrap", () => {
  it("exposes a liveness endpoint without leaking Fastify into core", async () => {
    const server = createServer({
      projectApplication: unusedProjectApplication,
      layoutApplication: unusedLayoutApplication,
      sqlImportApplication: unusedSqlImportApplication,
      sqlExportApplication: unusedSqlExportApplication,
      visualCommandApplication: unusedVisualCommandApplication,
      projectBundleApplication: unusedProjectBundleApplication,
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("reports readiness without exposing probe failures", async () => {
    let ready = false;
    const server = createServer({
      projectApplication: unusedProjectApplication,
      layoutApplication: unusedLayoutApplication,
      sqlImportApplication: unusedSqlImportApplication,
      sqlExportApplication: unusedSqlExportApplication,
      visualCommandApplication: unusedVisualCommandApplication,
      projectBundleApplication: unusedProjectBundleApplication,
      readinessProbe: () => ready,
    });
    servers.push(server);

    const unavailable = await server.inject({ method: "GET", url: "/health/ready" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers["cache-control"]).toBe("no-store");
    expect(unavailable.headers["retry-after"]).toBe("1");
    expect(unavailable.json()).toMatchObject({ code: "SERVER_NOT_READY" });

    ready = true;
    const available = await server.inject({ method: "GET", url: "/health/ready" });
    expect(available.statusCode).toBe(200);
    expect(available.headers["cache-control"]).toBe("no-store");
    expect(available.json()).toEqual({ status: "ready" });
  });
});

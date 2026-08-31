import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LayoutApplication,
  ProjectApplication,
  ProjectBundleApplication,
  SqlExportApplication,
  SqlImportApplication,
  VisualCommandApplication,
} from "@er-diagram/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createServer,
  type HttpCompletionOperationalLog,
  type OperationalLogEvent,
  SECURITY_HEADERS,
} from "../src/index.js";

const servers = new Set<ReturnType<typeof createServer>>();
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
  directories.clear();
});

describe("production Web static serving", () => {
  it("serves the SPA and hashed assets with the security and cache policy", async () => {
    const events: OperationalLogEvent[] = [];
    const server = createStaticServer(events);

    const root = await server.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    const asset = await server.inject({ method: "GET", url: "/assets/app-deadbeef.js" });
    const deepRoute = await server.inject({
      method: "GET",
      url: "/projects/019d3f4e-7b6c-7abc-8def-0123456789ab",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const headRoute = await server.inject({
      method: "HEAD",
      url: "/sql-import/new",
      headers: { accept: "text/html" },
    });

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id="root">packaged app</div>');
    expect(root.headers["cache-control"]).toBe("no-store");
    expect(root.headers["content-type"]).toMatch(/^text\/html/u);
    expect(root.headers["content-security-policy"]).toBe(
      SECURITY_HEADERS["content-security-policy"],
    );

    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("globalThis.packaged = true;\n");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["content-type"]).toMatch(/javascript/u);

    expect(deepRoute.statusCode).toBe(200);
    expect(deepRoute.body).toBe(root.body);
    expect(deepRoute.headers["cache-control"]).toBe("no-store");
    expect(headRoute.statusCode).toBe(200);
    expect(headRoute.body).toBe("");

    expect(events).toHaveLength(4);
    for (const event of events as HttpCompletionOperationalLog[]) {
      expect(event.operation).toBe("WEB_STATIC");
      expect(JSON.stringify(event)).not.toContain("projects/");
      expect(JSON.stringify(event)).not.toContain("app-deadbeef.js");
    }
  });

  it("keeps API, health, unsafe-path, and non-navigation misses on the JSON 404 boundary", async () => {
    const server = createStaticServer([]);
    const responses = await Promise.all([
      server.inject({
        method: "GET",
        url: "/api/v1/missing",
        headers: { accept: "text/html" },
      }),
      server.inject({
        method: "GET",
        url: "/health/missing",
        headers: { accept: "text/html" },
      }),
      server.inject({ method: "GET", url: "/.secret" }),
      server.inject({
        method: "GET",
        url: "/.secret",
        headers: { accept: "text/html" },
      }),
      server.inject({
        method: "GET",
        url: "/assets/missing-deadbeef.js",
        headers: { accept: "text/html" },
      }),
      server.inject({
        method: "GET",
        url: "/favicon.ico",
        headers: { accept: "text/html" },
      }),
      server.inject({
        method: "GET",
        url: "/%2eenv",
        headers: { accept: "text/html" },
      }),
      server.inject({
        method: "GET",
        url: "/%5cetc",
        headers: { accept: "text/html" },
      }),
      server.inject({
        method: "POST",
        url: "/projects/new",
        headers: { accept: "text/html" },
      }),
      server.inject({ method: "GET", url: "/missing.json" }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      404, 404, 404, 404, 404, 404, 404, 404, 404, 404,
    ]);
    for (const response of responses) {
      expect(response.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });
      expect(response.headers["cache-control"]).not.toBe("public, max-age=31536000, immutable");
    }
  });
});

function createStaticServer(events: OperationalLogEvent[]): ReturnType<typeof createServer> {
  const rootDirectory = mkdtempSync(join(tmpdir(), "er-diagram-static-web-"));
  directories.add(rootDirectory);
  mkdirSync(join(rootDirectory, "assets"));
  writeFileSync(
    join(rootDirectory, "index.html"),
    '<!doctype html><html><body><div id="root">packaged app</div></body></html>\n',
  );
  writeFileSync(join(rootDirectory, "assets", "app-deadbeef.js"), "globalThis.packaged = true;\n");
  writeFileSync(join(rootDirectory, ".secret"), "not public\n");

  const server = createServer({
    projectApplication: {} as ProjectApplication,
    layoutApplication: {} as LayoutApplication,
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: {} as VisualCommandApplication,
    projectBundleApplication: {} as ProjectBundleApplication,
    staticWeb: { rootDirectory },
    operationalLogSink: {
      write: (event) => {
        events.push(event);
      },
    },
  });
  servers.add(server);
  return server;
}

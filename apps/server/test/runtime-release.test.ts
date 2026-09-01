import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVELOPMENT_RUNTIME_RELEASE_IDENTITY,
  RUNTIME_CONFIG_VERSION,
  runtimeConfigResponseSchema,
  type RuntimeReleaseIdentity,
} from "@er-diagram/contracts";
import type {
  LayoutApplication,
  ProjectApplication,
  ProjectBundleApplication,
  SqlExportApplication,
  SqlImportApplication,
  VisualCommandApplication,
} from "@er-diagram/core";
import { afterEach, describe, expect, it } from "vitest";

import { createServer, readRuntimeReleaseIdentityFile } from "../src/index.js";

const directories = new Set<string>();
const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
  directories.clear();
});

describe("runtime release identity", () => {
  it("publishes the injected release evidence in runtime config version 2", async () => {
    const release: RuntimeReleaseIdentity = {
      channel: "RELEASE",
      version: "1.2.3",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      imageReference: "ghcr.io/hojooo/er-diagram:1.2.3",
      parserVersion: "9.1.1",
      bundleSchemaVersion: 1,
    };
    const server = testServer(release);

    const response = await server.inject({ method: "GET", url: "/api/v1/runtime-config" });

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(runtimeConfigResponseSchema.parse(response.json())).toMatchObject({
      configVersion: RUNTIME_CONFIG_VERSION,
      release,
    });
  });

  it("reads only a strict small regular packaged manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "er-diagram-release-identity-"));
    directories.add(directory);
    const filename = join(directory, "release.json");
    writeFileSync(filename, `${JSON.stringify(DEVELOPMENT_RUNTIME_RELEASE_IDENTITY)}\n`);

    expect(readRuntimeReleaseIdentityFile(filename)).toEqual(DEVELOPMENT_RUNTIME_RELEASE_IDENTITY);
    writeFileSync(filename, '{"channel":"DEVELOPMENT","version":"development"}\n');
    expect(() => readRuntimeReleaseIdentityFile(filename)).toThrow();
  });
});

function testServer(releaseIdentity: RuntimeReleaseIdentity) {
  const server = createServer({
    projectApplication: {} as ProjectApplication,
    layoutApplication: {} as LayoutApplication,
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: {} as VisualCommandApplication,
    projectBundleApplication: {} as ProjectBundleApplication,
    releaseIdentity,
  });
  servers.add(server);
  return server;
}

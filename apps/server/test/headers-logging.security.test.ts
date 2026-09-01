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
  createJsonLineOperationalLogSink,
  createServer,
  flushOperationalLog,
  type OperationalLogEvent,
  type OperationalLogSink,
} from "../src/index.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe("production health headers and lifecycle logging", () => {
  it("keeps readiness private and only emits HSTS for a trusted HTTPS proxy", async () => {
    const events: OperationalLogEvent[] = [];
    const server = testServer({
      readinessProbe: () => false,
      operationalLogSink: collectingSink(events),
      trustedProxyCidrs: ["127.0.0.1"],
      hstsMaxAgeSeconds: 31_536_000,
    });
    const unavailable = await server.inject({ method: "GET", url: "/health/ready" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers["cache-control"]).toBe("no-store");
    expect(unavailable.headers["retry-after"]).toBe("1");
    expect(unavailable.headers["strict-transport-security"]).toBeUndefined();

    const trustedHttps = await server.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-forwarded-proto": "https" },
      remoteAddress: "127.0.0.1",
    });
    expect(trustedHttps.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(events.map((event) => event.event)).toEqual([
      "HTTP_REQUEST_COMPLETED",
      "HTTP_REQUEST_COMPLETED",
    ]);
    expect(JSON.stringify(events)).not.toContain("x-forwarded-proto");
  });

  it("flushes pending JSON lines and ignores sink flush failures", async () => {
    let releaseWrite: (() => void) | undefined;
    const sink = createJsonLineOperationalLogSink(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    sink.write({
      logVersion: 1,
      event: "SERVER_LIFECYCLE",
      timestamp: "2026-08-31T00:00:00.000Z",
      state: "STOPPED",
    });
    let finished = false;
    const pending = flushOperationalLog(sink).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseWrite?.();
    await pending;
    expect(finished).toBe(true);

    await expect(
      flushOperationalLog({
        write: () => undefined,
        flush: async () => {
          throw new Error("native path and source sentinel");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

function testServer(
  overrides: Partial<Parameters<typeof createServer>[0]>,
): ReturnType<typeof createServer> {
  const server = createServer({
    projectApplication: {} as ProjectApplication,
    layoutApplication: {} as LayoutApplication,
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: {} as VisualCommandApplication,
    projectBundleApplication: {} as ProjectBundleApplication,
    ...overrides,
  });
  servers.add(server);
  return server;
}

function collectingSink(events: OperationalLogEvent[]): OperationalLogSink {
  return {
    write: (event) => {
      events.push(event);
    },
  };
}

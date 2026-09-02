#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";

import { requiredOciMetadata } from "./release-image-evidence.mjs";

const [reference, version, revision, expectedCycloneDxSha256, expectedElkLicenseSha256] =
  process.argv.slice(2);
if (
  !reference ||
  !version ||
  !revision ||
  !/^[0-9a-f]{64}$/u.test(expectedCycloneDxSha256 ?? "") ||
  !/^[0-9a-f]{64}$/u.test(expectedElkLicenseSha256 ?? "")
) {
  fail("RELEASE_RUNTIME_ARGUMENT_INVALID");
}
const metadata = requiredOciMetadata({ version, revision });
const results = [];

try {
  for (const architecture of ["amd64", "arm64"]) {
    run(["pull", "--platform", `linux/${architecture}`, reference]);
    const config = JSON.parse(
      capture(["image", "inspect", reference, "--format", "{{json .Config}}"]),
    );
    assert.equal(config.User, "node");
    assert.deepEqual(config.Cmd, ["node", "dist/production-entrypoint.js"]);
    for (const [key, value] of Object.entries(metadata)) assert.equal(config.Labels?.[key], value);
    const runtime = JSON.parse(
      capture([
        "run",
        "--rm",
        "--platform",
        `linux/${architecture}`,
        "--entrypoint",
        "node",
        reference,
        "--input-type=module",
        "-e",
        probe(),
      ]),
    );
    assert.equal(runtime.architecture, architecture);
    assert.equal(runtime.uid, 1000);
    assert.equal(runtime.version, version);
    assert.equal(runtime.sourceRevision, revision);
    assert.equal(runtime.parserVersion, "9.1.1");
    assert.equal(runtime.bundleSchemaVersion, 1);
    assert.equal(runtime.parsedTableCount, 1);
    assert.equal(runtime.cyclonedxSha256, expectedCycloneDxSha256);
    assert.equal(runtime.elkLicenseSha256, expectedElkLicenseSha256);
    assert.ok(runtime.elkLicenseBytes > 10_000);
    results.push({ platform: `linux/${architecture}`, ...runtime });
    run(["image", "rm", "--force", reference]);
  }
  process.stdout.write(`${JSON.stringify({ status: "ok", platforms: results })}\n`);
} catch {
  fail("RELEASE_RUNTIME_SMOKE_FAILED");
}

function probe() {
  return `
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    const identity = JSON.parse(readFileSync("/app/release.json", "utf8"));
    const cyclonedxBytes = readFileSync("/app/sbom/er-diagram.cdx.json");
    const cyclonedx = JSON.parse(cyclonedxBytes.toString("utf8"));
    if (cyclonedx.specVersion !== "1.6") throw new Error("release CycloneDX is invalid");
    if (!cyclonedx.components.some(({ name }) => name === "better-sqlite3")) {
      throw new Error("release CycloneDX production closure is incomplete");
    }
    if (cyclonedx.components.some(({ name }) => name === "@cyclonedx/cyclonedx-library")) {
      throw new Error("development SBOM generator leaked into the runtime closure");
    }
    const elkLicense = readFileSync("/app/licenses/elkjs-EPL-2.0.txt");
    const elkLicenseBytes = elkLicense.length;
    const serverPackage = await import("/app/server/dist/index.js");
    const executor = serverPackage.createResourceExecutor({
      limits: {
        ...serverPackage.DEFAULT_SERVER_RESOURCE_LIMITS,
        bundle: { ...serverPackage.DEFAULT_SERVER_RESOURCE_LIMITS.bundle },
        dbmlParserTimeoutMs: 60_000,
        workerPoolSize: 1,
      },
      operationalLogSink: serverPackage.NOOP_OPERATIONAL_LOG_SINK,
    });
    let parsed;
    try {
      parsed = await executor.parseDbml("Table public.release_smoke { id int [pk] }", "/main.dbml");
    } finally {
      await executor.close();
    }
    if (!parsed?.ok) throw new Error("release resource worker failed");
    console.log(JSON.stringify({
      architecture: process.arch === "x64" ? "amd64" : process.arch,
      uid: process.getuid?.(),
      version: identity.version,
      sourceRevision: identity.sourceRevision,
      parserVersion: identity.parserVersion,
      bundleSchemaVersion: identity.bundleSchemaVersion,
      cyclonedxSha256: createHash("sha256").update(cyclonedxBytes).digest("hex"),
      elkLicenseSha256: createHash("sha256").update(elkLicense).digest("hex"),
      elkLicenseBytes,
      parsedTableCount: parsed.graph.tables.length,
    }));
  `;
}

function capture(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function run(args) {
  execFileSync("docker", args, { stdio: "inherit" });
}

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

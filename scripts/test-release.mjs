import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectOciLayout, requiredOciMetadata } from "./release-image-evidence.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRevision = capture("git", ["rev-parse", "HEAD"]);
const version = "0.0.0";
const imageReference = `ghcr.io/hojooo/er-diagram:${version}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "er-diagram-release-test-"));
const archive = join(temporaryDirectory, "image.oci.tar");
const layout = join(temporaryDirectory, "layout");
const imagePrefix = `er-diagram-release-test-${process.pid}`;
const metadata = requiredOciMetadata({ version, revision: sourceRevision });
const images = [];

try {
  run("docker", ["version"]);
  run("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64,linux/arm64",
    "--output",
    `type=oci,dest=${archive}`,
    "--provenance=false",
    "--sbom=false",
    ...releaseBuildArguments(),
    ...annotationArguments(metadata),
    repositoryRoot,
  ]);
  mkdirSync(layout);
  run("tar", ["-xf", archive, "-C", layout]);
  const evidence = inspectOciLayout(layout, { version, revision: sourceRevision });

  for (const architecture of ["amd64", "arm64"]) {
    const image = `${imagePrefix}:${architecture}`;
    images.push(image);
    run("docker", [
      "buildx",
      "build",
      "--platform",
      `linux/${architecture}`,
      "--load",
      "--tag",
      image,
      "--provenance=false",
      "--sbom=false",
      ...releaseBuildArguments(),
      repositoryRoot,
    ]);
    const result = JSON.parse(
      capture("docker", [
        "run",
        "--rm",
        "--platform",
        `linux/${architecture}`,
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        runtimeProbe(),
      ]),
    );
    assert.deepEqual(result, {
      architecture,
      uid: 1000,
      version,
      sourceRevision,
      parserVersion: "9.1.1",
      bundleSchemaVersion: 1,
      parsedTableCount: 1,
    });
  }

  process.stdout.write(
    `${JSON.stringify({ status: "ok", ...evidence, runtimePlatforms: ["linux/amd64", "linux/arm64"] })}\n`,
  );
} finally {
  for (const image of images) {
    try {
      run("docker", ["image", "rm", "--force", image]);
    } catch {
      // Cleanup is best-effort and scoped to test-owned image names.
    }
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function releaseBuildArguments() {
  return [
    "--build-arg",
    `OCI_REVISION=${sourceRevision}`,
    "--build-arg",
    `OCI_VERSION=${version}`,
    "--build-arg",
    "RUNTIME_RELEASE_CHANNEL=RELEASE",
    "--build-arg",
    `RUNTIME_RELEASE_VERSION=${version}`,
    "--build-arg",
    `RUNTIME_RELEASE_SOURCE_REVISION=${sourceRevision}`,
    "--build-arg",
    `RUNTIME_RELEASE_IMAGE_REFERENCE=${imageReference}`,
  ];
}

function annotationArguments(values) {
  return Object.entries(values).flatMap(([key, value]) => [
    "--annotation",
    `index:${key}=${value}`,
    "--annotation",
    `manifest:${key}=${value}`,
  ]);
}

function runtimeProbe() {
  return `
    import { readFileSync } from "node:fs";
    const identity = JSON.parse(readFileSync("/app/release.json", "utf8"));
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
      parsedTableCount: parsed.graph.tables.length,
    }));
  `;
}

function capture(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    maxBuffer: 32 * 1024 * 1024,
  });
}

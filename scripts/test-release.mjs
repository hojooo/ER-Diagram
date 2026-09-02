import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILDKIT_SBOM_GENERATOR,
  extractOciSpdxDocuments,
  inspectOciLayout,
  requiredOciMetadata,
} from "./release-image-evidence.mjs";
import {
  finalizeReleaseAssets,
  prepareApplicationReleaseAssets,
  validateReleaseAssetDirectory,
  writeSpdxReleaseAssets,
} from "./release-sbom-assets.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRevision = capture("git", ["rev-parse", "HEAD"]);
const version = "0.0.0";
const imageReference = `ghcr.io/hojooo/er-diagram:${version}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "er-diagram-release-test-"));
const archive = join(temporaryDirectory, "image.oci.tar");
const layout = join(temporaryDirectory, "layout");
const releaseAssets = join(temporaryDirectory, "release-assets");
const imagePrefix = `er-diagram-release-test-${process.pid}`;
const metadata = requiredOciMetadata({ version, revision: sourceRevision });
const images = [];

try {
  const applicationAssets = await prepareApplicationReleaseAssets({
    imageReference,
    outputDirectory: releaseAssets,
    repositoryRoot,
    revision: sourceRevision,
    version,
  });
  run("docker", ["version"]);
  run("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64,linux/arm64",
    "--output",
    `type=oci,dest=${archive},oci-artifact=true`,
    "--provenance=false",
    `--sbom=generator=${BUILDKIT_SBOM_GENERATOR}`,
    ...releaseBuildArguments(),
    ...annotationArguments(metadata),
    repositoryRoot,
  ]);
  mkdirSync(layout);
  run("tar", ["-xf", archive, "-C", layout]);
  const evidence = inspectOciLayout(layout, { version, revision: sourceRevision });
  writeSpdxReleaseAssets({
    documentsByPlatform: extractOciSpdxDocuments(layout, {
      version,
      revision: sourceRevision,
    }),
    outputDirectory: releaseAssets,
    version,
  });
  finalizeReleaseAssets({ outputDirectory: releaseAssets, version });
  validateReleaseAssetDirectory({
    imageReference,
    outputDirectory: releaseAssets,
    repositoryRoot,
    revision: sourceRevision,
    version,
  });

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
      cyclonedxSha256: applicationAssets.cyclonedxSha256,
      elkLicenseBytes: applicationAssets.elkLicenseBytes,
      elkLicenseSha256: applicationAssets.elkLicenseSha256,
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
    if (elkLicenseBytes < 10_000) throw new Error("EPL license evidence is incomplete");
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
      elkLicenseBytes,
      elkLicenseSha256: createHash("sha256").update(elkLicense).digest("hex"),
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

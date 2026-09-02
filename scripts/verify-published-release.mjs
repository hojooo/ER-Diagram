#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseCandidateArguments, ReleaseCandidateError } from "./release-candidate.mjs";
import { validateReleaseAssetDirectory } from "./release-sbom-assets.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export class PublishedReleaseError extends Error {
  constructor(code = "RELEASE_PUBLISHED_EVIDENCE_INVALID") {
    super(code);
    this.name = "PublishedReleaseError";
    this.code = code;
  }
}

export function validatePublishedReleaseEvidence(value) {
  const expectedTag = `v${value.version}`;
  const expectedImage = `ghcr.io/hojooo/er-diagram:${value.version}`;
  const expectedReleaseUrl = `https://github.com/hojooo/ER-Diagram/releases/tag/${expectedTag}`;
  const expectedFiles = [
    "SHA256SUMS",
    "elkjs-0.12.0-EPL-2.0.txt",
    "elkjs-0.12.0-source.tgz",
    `er-diagram-${value.version}-linux-amd64.spdx.json`,
    `er-diagram-${value.version}-linux-arm64.spdx.json`,
    `er-diagram-${value.version}.cdx.json`,
  ].sort(compareCodeUnits);
  const expectedPlatforms = ["linux/amd64", "linux/arm64"];
  if (
    value.exactImage?.version !== value.version ||
    value.latestImage?.version !== value.version ||
    value.exactImage?.sourceRevision !== value.revision ||
    value.latestImage?.sourceRevision !== value.revision ||
    value.exactImage?.digest !== value.latestImage?.digest ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.exactImage?.digest ?? "") ||
    JSON.stringify(value.exactImage?.platforms) !== JSON.stringify(expectedPlatforms) ||
    JSON.stringify(value.latestImage?.platforms) !== JSON.stringify(expectedPlatforms) ||
    value.release?.tagName !== expectedTag ||
    value.release?.url !== expectedReleaseUrl ||
    !value.release?.body?.includes(value.revision) ||
    !value.release?.body?.includes(expectedImage) ||
    !value.release?.body?.includes(value.exactImage.digest) ||
    JSON.stringify([...(value.assets?.files ?? [])].sort(compareCodeUnits)) !==
      JSON.stringify(expectedFiles) ||
    !/^[0-9a-f]{64}$/u.test(value.assets?.sha256sumsSha256 ?? "")
  ) {
    throw new PublishedReleaseError();
  }
  return Object.freeze({
    digest: value.exactImage.digest,
    platforms: Object.freeze(expectedPlatforms),
    revision: value.revision,
    releaseUrl: expectedReleaseUrl,
    tag: expectedTag,
    version: value.version,
  });
}

export async function verifyPublishedRelease(argv) {
  if (!argv.includes("--version") || !argv.includes("--revision")) {
    throw new PublishedReleaseError("RELEASE_PUBLISHED_ARGUMENT_INVALID");
  }
  let candidate;
  try {
    candidate = parseReleaseCandidateArguments(argv, {
      defaultRevision: "0".repeat(40),
      defaultVersion: "0.0.0",
    });
  } catch (error) {
    if (error instanceof ReleaseCandidateError) {
      throw new PublishedReleaseError("RELEASE_PUBLISHED_ARGUMENT_INVALID");
    }
    throw error;
  }
  const { revision, version } = candidate;
  const tag = `v${version}`;
  const exactReference = `ghcr.io/hojooo/er-diagram:${version}`;
  const latestReference = "ghcr.io/hojooo/er-diagram:latest";
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "er-diagram-release-verify-"));
  chmodSync(temporaryDirectory, 0o700);
  const assetDirectory = path.join(temporaryDirectory, "assets");
  const dockerConfig = path.join(temporaryDirectory, "docker-config");
  try {
    mkdirSync(assetDirectory, { mode: 0o700 });
    mkdirSync(dockerConfig, { mode: 0o700 });
    writeFileSync(path.join(dockerConfig, "config.json"), '{"auths":{}}\n', { mode: 0o600 });

    const exactImage = parseJson(
      capture(process.execPath, [
        path.join(repositoryRoot, "scripts", "check-release-remote.mjs"),
        exactReference,
        version,
        revision,
      ]),
    );
    const latestImage = parseJson(
      capture(process.execPath, [
        path.join(repositoryRoot, "scripts", "check-release-remote.mjs"),
        latestReference,
        version,
        revision,
      ]),
    );
    const release = parseJson(
      capture("gh", [
        "release",
        "view",
        tag,
        "--repo",
        "hojooo/ER-Diagram",
        "--json",
        "tagName,body,url",
      ]),
    );
    run("gh", ["release", "download", tag, "--repo", "hojooo/ER-Diagram", "--dir", assetDirectory]);
    const assets = validateReleaseAssetDirectory({
      imageReference: exactReference,
      outputDirectory: assetDirectory,
      repositoryRoot,
      revision,
      version,
    });
    const evidence = validatePublishedReleaseEvidence({
      version,
      revision,
      exactImage,
      latestImage,
      release,
      assets,
    });

    const anonymousEnvironment = { ...process.env, DOCKER_CONFIG: dockerConfig };
    run(
      "docker",
      ["pull", `${exactReference.split(":").slice(0, -1).join(":")}@${evidence.digest}`],
      {
        env: anonymousEnvironment,
      },
    );
    run(process.execPath, [
      path.join(repositoryRoot, "scripts", "check-release-runtime.mjs"),
      `ghcr.io/hojooo/er-diagram@${evidence.digest}`,
      version,
      revision,
      assets.cyclonedxSha256,
      assets.elkLicenseSha256,
    ]);
    return Object.freeze({ ...evidence, sha256sumsSha256: assets.sha256sumsSha256 });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function capture(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new PublishedReleaseError();
  }
}

function run(command, args, options = {}) {
  capture(command, args, options);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new PublishedReleaseError();
  }
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    const evidence = await verifyPublishedRelease(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    const code =
      error instanceof PublishedReleaseError ? error.code : "RELEASE_PUBLISHED_EVIDENCE_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

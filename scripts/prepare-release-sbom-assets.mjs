#!/usr/bin/env node
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareReleaseAssetDirectories,
  extractRemoteSpdxDocuments,
  finalizeReleaseAssets,
  prepareApplicationReleaseAssets,
  ReleaseSbomAssetError,
  validateReleaseAssetDirectory,
  writeSpdxReleaseAssets,
} from "./release-sbom-assets.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [operation, ...rawArguments] = process.argv.slice(2);
const argumentsByName = parseArguments(rawArguments);

try {
  if (operation === "application") {
    await prepareApplicationReleaseAssets({
      imageReference: required("image-reference"),
      outputDirectory: resolve(required("output")),
      repositoryRoot,
      revision: required("revision"),
      version: required("version"),
    });
  } else if (operation === "remote-spdx") {
    const outputDirectory = resolve(required("output"));
    writeSpdxReleaseAssets({
      documentsByPlatform: extractRemoteSpdxDocuments(required("reference")),
      outputDirectory,
      version: required("version"),
    });
  } else if (operation === "finalize") {
    const result = finalizeReleaseAssets({
      outputDirectory: resolve(required("output")),
      version: required("version"),
    });
    const validation = validateReleaseAssetDirectory({
      imageReference: required("image-reference"),
      outputDirectory: resolve(required("output")),
      repositoryRoot,
      revision: required("revision"),
      version: required("version"),
    });
    process.stdout.write(
      `${JSON.stringify({
        cyclonedxSha256: validation.cyclonedxSha256,
        elkLicenseSha256: validation.elkLicenseSha256,
        elkSourceSha256: validation.elkSourceSha256,
        files: result.files,
        sha256sumsSha256: validation.sha256sumsSha256,
        status: "ok",
      })}\n`,
    );
  } else if (operation === "compare") {
    compareReleaseAssetDirectories(resolve(required("expected")), resolve(required("actual")));
    process.stdout.write(`${JSON.stringify({ status: "ok" })}\n`);
  } else {
    fail("RELEASE_SBOM_OPERATION_INVALID");
  }
} catch (error) {
  fail(error instanceof ReleaseSbomAssetError ? error.code : "RELEASE_SBOM_ASSET_FAILED");
}

function required(name) {
  const value = argumentsByName.get(name);
  if (!value) fail("RELEASE_SBOM_ARGUMENT_INVALID");
  return value;
}

function parseArguments(values) {
  if (values.length % 2 !== 0) fail("RELEASE_SBOM_ARGUMENT_INVALID");
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/u, "");
    const value = values[index + 1];
    if (!name || !value || parsed.has(name)) fail("RELEASE_SBOM_ARGUMENT_INVALID");
    parsed.set(name, value);
  }
  return parsed;
}

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

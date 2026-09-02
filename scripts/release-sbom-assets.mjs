import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  collectProductionDependencyRecords,
  createCycloneDxSbom,
  validateCycloneDxDocument,
} from "./sbom-evidence.mjs";
import { validateSpdxDocument } from "./release-image-evidence.mjs";

export const ELK_VERSION = "0.12.0";
export const ELK_SOURCE_URL = `https://registry.npmjs.org/elkjs/-/elkjs-${ELK_VERSION}.tgz`;
export const RELEASE_SBOM_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);

const MAX_EPL_SOURCE_BYTES = 16 * 1024 * 1024;

export class ReleaseSbomAssetError extends Error {
  constructor(code, message = "Release SBOM asset validation failed.") {
    super(message);
    this.name = "ReleaseSbomAssetError";
    this.code = code;
  }
}

export function releaseAssetNames(version) {
  assertStableVersion(version);
  return Object.freeze({
    cyclonedx: `er-diagram-${version}.cdx.json`,
    eplLicense: `elkjs-${ELK_VERSION}-EPL-2.0.txt`,
    eplSource: `elkjs-${ELK_VERSION}-source.tgz`,
    sha256sums: "SHA256SUMS",
    spdx: Object.freeze({
      "linux/amd64": `er-diagram-${version}-linux-amd64.spdx.json`,
      "linux/arm64": `er-diagram-${version}-linux-arm64.spdx.json`,
    }),
  });
}

export async function prepareApplicationReleaseAssets({
  fetchImplementation = fetch,
  imageReference,
  outputDirectory,
  repositoryRoot,
  revision,
  version,
}) {
  ensureDirectory(outputDirectory);
  const names = releaseAssetNames(version);
  const sbom = createCycloneDxSbom({
    imageReference,
    records: collectProductionDependencyRecords(repositoryRoot),
    revision,
    version,
  });
  writeExclusive(join(outputDirectory, names.cyclonedx), sbom.text);

  const elkEvidence = readElkEvidence(repositoryRoot);
  const sourceBytes = await downloadBounded(fetchImplementation, ELK_SOURCE_URL);
  verifyIntegrity(sourceBytes, elkEvidence.integrity);
  writeExclusive(join(outputDirectory, names.eplSource), sourceBytes);
  writeExclusive(join(outputDirectory, names.eplLicense), elkEvidence.licenseBytes);

  return Object.freeze({
    cyclonedxSha256: sbom.sha256,
    elkLicenseBytes: elkEvidence.licenseBytes.length,
    elkLicenseSha256: sha256(elkEvidence.licenseBytes),
    elkSourceSha256: sha256(sourceBytes),
  });
}

export function writeSpdxReleaseAssets({ documentsByPlatform, outputDirectory, version }) {
  ensureDirectory(outputDirectory);
  const names = releaseAssetNames(version);
  const written = [];
  for (const platform of RELEASE_SBOM_PLATFORMS) {
    const document =
      documentsByPlatform instanceof Map
        ? documentsByPlatform.get(platform)
        : documentsByPlatform[platform];
    validateSpdxDocument(document);
    const text = `${JSON.stringify(sortObjectKeys(document), null, 2)}\n`;
    const filename = names.spdx[platform];
    writeExclusive(join(outputDirectory, filename), text);
    written.push(Object.freeze({ filename, platform, sha256: sha256(text) }));
  }
  return Object.freeze(written);
}

export function extractRemoteSpdxDocuments(reference) {
  const documents = new Map();
  for (const platform of RELEASE_SBOM_PLATFORMS) {
    const raw = execFileSync(
      "docker",
      [
        "buildx",
        "imagetools",
        "inspect",
        reference,
        "--format",
        `{{ json (index .SBOM "${platform}").SPDX }}`,
      ],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      throw assetError("RELEASE_SPDX_REMOTE_INVALID");
    }
    validateSpdxDocument(document);
    documents.set(platform, document);
  }
  return documents;
}

export function finalizeReleaseAssets({ outputDirectory, version }) {
  const names = releaseAssetNames(version);
  const contentNames = expectedContentNames(names);
  assertExactFileSet(outputDirectory, contentNames);
  const checksums = contentNames.map((filename) => {
    const bytes = readRegularFile(join(outputDirectory, filename));
    return `${sha256(bytes)}  ${filename}`;
  });
  const text = `${checksums.join("\n")}\n`;
  writeExclusive(join(outputDirectory, names.sha256sums), text);
  return Object.freeze({ files: Object.freeze([...contentNames, names.sha256sums]), text });
}

export function validateReleaseAssetDirectory({
  imageReference,
  outputDirectory,
  repositoryRoot,
  revision,
  version,
}) {
  const names = releaseAssetNames(version);
  const expectedNames = [...expectedContentNames(names), names.sha256sums];
  assertExactFileSet(outputDirectory, expectedNames);

  const cyclonedxText = readRegularFile(join(outputDirectory, names.cyclonedx)).toString("utf8");
  let cyclonedx;
  try {
    cyclonedx = JSON.parse(cyclonedxText);
  } catch {
    throw assetError("RELEASE_CYCLONEDX_ASSET_INVALID");
  }
  if (cyclonedxText !== canonicalJsonText(cyclonedx)) {
    throw assetError("RELEASE_CYCLONEDX_ASSET_NON_CANONICAL");
  }
  validateCycloneDxDocument(cyclonedx, { imageReference, revision, version });

  for (const filename of Object.values(names.spdx)) {
    const spdxText = readRegularFile(join(outputDirectory, filename)).toString("utf8");
    let spdx;
    try {
      spdx = JSON.parse(spdxText);
    } catch {
      throw assetError("RELEASE_SPDX_ASSET_INVALID");
    }
    if (spdxText !== canonicalJsonText(spdx)) {
      throw assetError("RELEASE_SPDX_ASSET_NON_CANONICAL");
    }
    validateSpdxDocument(spdx);
  }

  const elkEvidence = readElkEvidence(repositoryRoot);
  const sourceBytes = readRegularFile(join(outputDirectory, names.eplSource));
  verifyIntegrity(sourceBytes, elkEvidence.integrity);
  const licenseBytes = readRegularFile(join(outputDirectory, names.eplLicense));
  if (!licenseBytes.equals(elkEvidence.licenseBytes)) {
    throw assetError("RELEASE_EPL_LICENSE_MISMATCH");
  }

  const expectedChecksums = `${expectedContentNames(names)
    .map((filename) => `${sha256(readRegularFile(join(outputDirectory, filename)))}  ${filename}`)
    .join("\n")}\n`;
  const actualChecksums = readRegularFile(join(outputDirectory, names.sha256sums)).toString("utf8");
  if (actualChecksums !== expectedChecksums) {
    throw assetError("RELEASE_SBOM_CHECKSUM_MISMATCH");
  }

  return Object.freeze({
    cyclonedxSha256: sha256(cyclonedxText),
    elkLicenseSha256: sha256(licenseBytes),
    elkSourceSha256: sha256(sourceBytes),
    files: Object.freeze(expectedNames),
    sha256sumsSha256: sha256(actualChecksums),
  });
}

export function compareReleaseAssetDirectories(expectedDirectory, actualDirectory) {
  const expectedFiles = listRegularFiles(expectedDirectory);
  const actualFiles = listRegularFiles(actualDirectory);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw assetError("RELEASE_SBOM_ASSET_CONFLICT");
  }
  for (const filename of expectedFiles) {
    if (
      !readRegularFile(join(expectedDirectory, filename)).equals(
        readRegularFile(join(actualDirectory, filename)),
      )
    ) {
      throw assetError("RELEASE_SBOM_ASSET_CONFLICT");
    }
  }
  return Object.freeze({ files: Object.freeze(expectedFiles) });
}

export function readElkEvidence(repositoryRoot) {
  const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const matches = [
    ...lockfile.matchAll(
      /^ {2}elkjs@0\.12\.0:\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}$/gmu,
    ),
  ];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw assetError("RELEASE_EPL_LOCKFILE_EVIDENCE_INVALID");
  }
  const requireFromWeb = createRequire(join(repositoryRoot, "apps", "web", "package.json"));
  const packageManifestPath = requireFromWeb.resolve("elkjs/package.json");
  const manifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (
    manifest.name !== "elkjs" ||
    manifest.version !== ELK_VERSION ||
    manifest.license !== "EPL-2.0 OR GPL-3.0-or-later"
  ) {
    throw assetError("RELEASE_EPL_PACKAGE_EVIDENCE_INVALID");
  }
  const licenseBytes = readFileSync(join(packageManifestPath, "..", "LICENSE.md"));
  if (
    !licenseBytes.toString("utf8").includes("# Eclipse Public License - v 2.0") ||
    licenseBytes.length < 10_000
  ) {
    throw assetError("RELEASE_EPL_LICENSE_INVALID");
  }
  return Object.freeze({ integrity: matches[0][1], licenseBytes });
}

export function verifyIntegrity(bytes, integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/u.exec(integrity ?? "");
  if (!match?.[1]) throw assetError("RELEASE_EPL_INTEGRITY_INVALID");
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (actual !== match[1]) throw assetError("RELEASE_EPL_SOURCE_INTEGRITY_MISMATCH");
}

async function downloadBounded(fetchImplementation, url) {
  let response;
  try {
    response = await fetchImplementation(url, { redirect: "error" });
  } catch {
    throw assetError("RELEASE_EPL_SOURCE_DOWNLOAD_FAILED");
  }
  if (!response?.ok || !response.body) {
    throw assetError("RELEASE_EPL_SOURCE_DOWNLOAD_FAILED");
  }
  const declaredLength = response.headers?.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_EPL_SOURCE_BYTES) {
    throw assetError("RELEASE_EPL_SOURCE_TOO_LARGE");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_EPL_SOURCE_BYTES) throw assetError("RELEASE_EPL_SOURCE_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function expectedContentNames(names) {
  return [names.cyclonedx, names.eplLicense, names.eplSource, ...Object.values(names.spdx)].sort(
    codeUnitCompare,
  );
}

function assertExactFileSet(directory, expectedNames) {
  const actualNames = listRegularFiles(directory);
  const sortedExpected = [...expectedNames].sort(codeUnitCompare);
  if (JSON.stringify(actualNames) !== JSON.stringify(sortedExpected)) {
    throw assetError("RELEASE_SBOM_ASSET_SET_INVALID");
  }
}

function listRegularFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    throw assetError("RELEASE_SBOM_ASSET_DIRECTORY_INVALID");
  }
  if (entries.some((entry) => !entry.isFile())) {
    throw assetError("RELEASE_SBOM_ASSET_FILE_TYPE_INVALID");
  }
  return entries.map(({ name }) => name).sort(codeUnitCompare);
}

function readRegularFile(filename) {
  let stats;
  try {
    stats = lstatSync(filename);
  } catch {
    throw assetError("RELEASE_SBOM_ASSET_MISSING");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw assetError("RELEASE_SBOM_ASSET_FILE_TYPE_INVALID");
  }
  return readFileSync(filename);
}

function writeExclusive(filename, contents) {
  try {
    writeFileSync(filename, contents, { flag: "wx", mode: 0o644 });
  } catch {
    throw assetError("RELEASE_SBOM_ASSET_WRITE_FAILED");
  }
}

function ensureDirectory(directory) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw assetError("RELEASE_SBOM_ASSET_DIRECTORY_INVALID");
  }
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => codeUnitCompare(left, right))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

function canonicalJsonText(value) {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertStableVersion(version) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version ?? "")) {
    throw assetError("RELEASE_SBOM_VERSION_INVALID");
  }
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assetError(code) {
  return new ReleaseSbomAssetError(code);
}

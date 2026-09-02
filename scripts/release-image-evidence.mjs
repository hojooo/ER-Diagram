import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"];
const REQUIRED_COMMAND = ["node", "dist/production-entrypoint.js"];

export class ReleaseImageEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseImageEvidenceError";
    this.code = code;
  }
}

export function stableVersionFromTag(tag) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(tag);
  if (!match?.[1]) throw evidenceError("RELEASE_VERSION_TAG_INVALID");
  return match[1];
}

export function requiredOciMetadata({ version, revision }) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw evidenceError("RELEASE_VERSION_INVALID");
  }
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw evidenceError("RELEASE_SOURCE_REVISION_INVALID");
  }
  return Object.freeze({
    "org.opencontainers.image.source": "https://github.com/hojooo/ER-Diagram",
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.licenses": "Apache-2.0",
    "org.opencontainers.image.title": "DBML SQL ERD Studio",
    "org.opencontainers.image.description": "Self-hosted DBML and SQL schema workspace",
  });
}

export function inspectOciLayout(layoutDirectory, expected) {
  const metadata = requiredOciMetadata(expected);
  const index = readJsonFile(join(layoutDirectory, "index.json"));
  assertObject(index, "RELEASE_OCI_INDEX_INVALID");
  if (index.schemaVersion !== 2 || index.mediaType !== OCI_INDEX) {
    throw evidenceError("RELEASE_OCI_INDEX_INVALID");
  }
  const imageIndex = resolveImageIndex(layoutDirectory, index, metadata);

  const manifests = collectManifests(layoutDirectory, imageIndex, new Set());
  const evidence = manifests.map(({ descriptor, manifest }) => {
    const platform = descriptor.platform;
    assertObject(platform, "RELEASE_OCI_PLATFORM_INVALID");
    const platformName = `${platform.os}/${platform.architecture}`;
    if (!REQUIRED_PLATFORMS.includes(platformName) || platform.variant !== undefined) {
      throw evidenceError("RELEASE_OCI_PLATFORM_INVALID");
    }
    assertMetadata(manifest.annotations, metadata, "RELEASE_OCI_MANIFEST_ANNOTATION_INVALID");
    const configDescriptor = manifest.config;
    assertDescriptor(configDescriptor, "RELEASE_OCI_CONFIG_INVALID");
    const config = readBlobJson(layoutDirectory, configDescriptor);
    assertObject(config, "RELEASE_OCI_CONFIG_INVALID");
    assertObject(config.config, "RELEASE_OCI_CONFIG_INVALID");
    if (config.os !== platform.os || config.architecture !== platform.architecture) {
      throw evidenceError("RELEASE_OCI_CONFIG_PLATFORM_MISMATCH");
    }
    if (config.config.User !== "node") throw evidenceError("RELEASE_OCI_ROOT_USER_INVALID");
    if (!sameStringArray(config.config.Cmd, REQUIRED_COMMAND)) {
      throw evidenceError("RELEASE_OCI_COMMAND_INVALID");
    }
    assertMetadata(config.config.Labels, metadata, "RELEASE_OCI_LABEL_INVALID");
    return Object.freeze({
      platform: platformName,
      manifestDigest: descriptor.digest,
      configDigest: configDescriptor.digest,
      user: config.config.User,
      command: [...config.config.Cmd],
    });
  });

  evidence.sort((left, right) => left.platform.localeCompare(right.platform, "en"));
  const actualPlatforms = evidence.map(({ platform }) => platform);
  const expectedPlatforms = [...REQUIRED_PLATFORMS].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (new Set(actualPlatforms).size !== actualPlatforms.length) {
    throw evidenceError("RELEASE_OCI_PLATFORM_DUPLICATE");
  }
  if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
    throw evidenceError("RELEASE_OCI_PLATFORM_SET_INVALID");
  }

  return Object.freeze({
    version: expected.version,
    sourceRevision: expected.revision,
    platforms: Object.freeze(evidence),
  });
}

function resolveImageIndex(layoutDirectory, layoutIndex, metadata) {
  if (metadataMatches(layoutIndex.annotations, metadata)) return layoutIndex;
  if (layoutIndex.manifests.length !== 1) {
    throw evidenceError("RELEASE_OCI_INDEX_ANNOTATION_INVALID");
  }
  const descriptor = layoutIndex.manifests[0];
  assertDescriptor(descriptor, "RELEASE_OCI_INDEX_DESCRIPTOR_INVALID");
  if (descriptor.mediaType !== OCI_INDEX || descriptor.platform !== undefined) {
    throw evidenceError("RELEASE_OCI_INDEX_DESCRIPTOR_INVALID");
  }
  const imageIndex = readBlobJson(layoutDirectory, descriptor);
  assertObject(imageIndex, "RELEASE_OCI_INDEX_INVALID");
  if (imageIndex.schemaVersion !== 2 || imageIndex.mediaType !== OCI_INDEX) {
    throw evidenceError("RELEASE_OCI_INDEX_INVALID");
  }
  assertMetadata(imageIndex.annotations, metadata, "RELEASE_OCI_INDEX_ANNOTATION_INVALID");
  return imageIndex;
}

function collectManifests(layoutDirectory, index, visited) {
  if (!Array.isArray(index.manifests)) throw evidenceError("RELEASE_OCI_INDEX_INVALID");
  return index.manifests.flatMap((descriptor) => {
    assertDescriptor(descriptor, "RELEASE_OCI_DESCRIPTOR_INVALID");
    if (visited.has(descriptor.digest)) throw evidenceError("RELEASE_OCI_DESCRIPTOR_CYCLE");
    visited.add(descriptor.digest);
    const document = readBlobJson(layoutDirectory, descriptor);
    if (descriptor.mediaType === OCI_INDEX) {
      assertObject(document, "RELEASE_OCI_INDEX_INVALID");
      if (document.schemaVersion !== 2 || document.mediaType !== OCI_INDEX) {
        throw evidenceError("RELEASE_OCI_INDEX_INVALID");
      }
      return collectManifests(layoutDirectory, document, visited);
    }
    if (descriptor.mediaType !== OCI_MANIFEST) {
      throw evidenceError("RELEASE_OCI_MEDIA_TYPE_UNSUPPORTED");
    }
    assertObject(document, "RELEASE_OCI_MANIFEST_INVALID");
    if (document.schemaVersion !== 2 || document.mediaType !== OCI_MANIFEST) {
      throw evidenceError("RELEASE_OCI_MANIFEST_INVALID");
    }
    return [{ descriptor, manifest: document }];
  });
}

function readJsonFile(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    throw evidenceError("RELEASE_OCI_JSON_INVALID");
  }
}

function readBlobJson(layoutDirectory, descriptor) {
  const [algorithm, digest] = descriptor.digest.split(":");
  if (algorithm !== "sha256" || !/^[0-9a-f]{64}$/u.test(digest ?? "")) {
    throw evidenceError("RELEASE_OCI_DIGEST_INVALID");
  }
  const filename = join(layoutDirectory, "blobs", "sha256", digest);
  let bytes;
  try {
    bytes = readFileSync(filename);
  } catch {
    throw evidenceError("RELEASE_OCI_BLOB_MISSING");
  }
  if (bytes.length !== descriptor.size) throw evidenceError("RELEASE_OCI_BLOB_SIZE_MISMATCH");
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw evidenceError("RELEASE_OCI_BLOB_HASH_MISMATCH");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw evidenceError("RELEASE_OCI_JSON_INVALID");
  }
}

function assertDescriptor(value, code) {
  assertObject(value, code);
  if (
    typeof value.mediaType !== "string" ||
    typeof value.digest !== "string" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    throw evidenceError(code);
  }
}

function assertMetadata(actual, expected, code) {
  assertObject(actual, code);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw evidenceError(code);
  }
}

function metadataMatches(actual, expected) {
  return (
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function assertObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw evidenceError(code);
  }
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function evidenceError(code) {
  return new ReleaseImageEvidenceError(code, "Release image evidence validation failed.");
}

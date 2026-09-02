import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_EMPTY_CONFIG = "application/vnd.oci.empty.v1+json";
const OCI_EMPTY_CONFIG_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const IN_TOTO_LAYER = "application/vnd.in-toto+json";
const IN_TOTO_STATEMENTS = new Set([
  "https://in-toto.io/Statement/v0.1",
  "https://in-toto.io/Statement/v1",
]);
const SPDX_PREDICATE = "https://spdx.dev/Document";
const ATTESTATION_ARTIFACT_TYPE = "application/vnd.docker.attestation.manifest.v1+json";
const ATTESTATION_REFERENCE_DIGEST = "vnd.docker.reference.digest";
const ATTESTATION_REFERENCE_TYPE = "vnd.docker.reference.type";
const ATTESTATION_REFERENCE_VALUE = "attestation-manifest";
const PREDICATE_TYPE_ANNOTATION = "in-toto.io/predicate-type";
const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"];
const REQUIRED_COMMAND = ["node", "dist/production-entrypoint.js"];

export const BUILDKIT_SBOM_GENERATOR =
  "docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9";

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
  return inspectOciLayoutDetails(layoutDirectory, expected).evidence;
}

export function extractOciSpdxDocuments(layoutDirectory, expected) {
  return inspectOciLayoutDetails(layoutDirectory, expected).spdxByPlatform;
}

function inspectOciLayoutDetails(layoutDirectory, expected) {
  const metadata = requiredOciMetadata(expected);
  const index = readJsonFile(join(layoutDirectory, "index.json"));
  assertObject(index, "RELEASE_OCI_INDEX_INVALID");
  if (index.schemaVersion !== 2 || index.mediaType !== OCI_INDEX) {
    throw evidenceError("RELEASE_OCI_INDEX_INVALID");
  }
  const imageIndex = resolveImageIndex(layoutDirectory, index, metadata);

  const manifests = collectLeafManifests(layoutDirectory, imageIndex, new Set());
  const imageManifests = manifests.filter(({ descriptor }) => !isAttestationDescriptor(descriptor));
  const attestationManifests = manifests.filter(({ descriptor }) =>
    isAttestationDescriptor(descriptor),
  );
  const spdxByManifestDigest = validateSbomAttestations(
    layoutDirectory,
    imageManifests,
    attestationManifests,
  );
  const spdxByPlatform = new Map();
  const evidence = imageManifests.map(({ descriptor, manifest }) => {
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
    const sbom = spdxByManifestDigest.get(descriptor.digest);
    if (!sbom) throw evidenceError("RELEASE_OCI_SBOM_MISSING");
    spdxByPlatform.set(platformName, sbom.document);
    return Object.freeze({
      platform: platformName,
      manifestDigest: descriptor.digest,
      configDigest: configDescriptor.digest,
      sbomDigest: sbom.layerDigest,
      spdxVersion: sbom.document.spdxVersion,
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
    evidence: Object.freeze({
      version: expected.version,
      sourceRevision: expected.revision,
      platforms: Object.freeze(evidence),
    }),
    spdxByPlatform,
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

function collectLeafManifests(layoutDirectory, index, visited) {
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
      return collectLeafManifests(layoutDirectory, document, visited);
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

function isAttestationDescriptor(descriptor) {
  const annotations = descriptor.annotations;
  const referenceType = annotations?.[ATTESTATION_REFERENCE_TYPE];
  const platform = descriptor.platform;
  const unknownPlatform =
    platform?.os === "unknown" &&
    platform?.architecture === "unknown" &&
    platform?.variant === undefined;
  if (referenceType === undefined && !unknownPlatform) return false;
  if (referenceType !== ATTESTATION_REFERENCE_VALUE || !unknownPlatform) {
    throw evidenceError("RELEASE_OCI_ATTESTATION_DESCRIPTOR_INVALID");
  }
  return true;
}

function validateSbomAttestations(layoutDirectory, imageManifests, attestationManifests) {
  const imageDigests = new Set(imageManifests.map(({ descriptor }) => descriptor.digest));
  const spdxByManifestDigest = new Map();

  for (const { descriptor, manifest } of attestationManifests) {
    const referencedDigest = descriptor.annotations?.[ATTESTATION_REFERENCE_DIGEST];
    if (!imageDigests.has(referencedDigest) || spdxByManifestDigest.has(referencedDigest)) {
      throw evidenceError("RELEASE_OCI_ATTESTATION_REFERENCE_INVALID");
    }
    const layer = validateAttestationManifestEnvelope(manifest, referencedDigest);
    const statement = readBlobJson(layoutDirectory, layer);
    validateSpdxStatement(statement, referencedDigest, { allowEmptySubject: true });
    spdxByManifestDigest.set(referencedDigest, {
      document: statement.predicate,
      layerDigest: layer.digest,
    });
  }

  if (
    spdxByManifestDigest.size !== imageDigests.size ||
    [...imageDigests].some((digest) => !spdxByManifestDigest.has(digest))
  ) {
    throw evidenceError("RELEASE_OCI_SBOM_SET_INVALID");
  }
  return spdxByManifestDigest;
}

export function validateAttestationManifestEnvelope(manifest, expectedManifestDigest) {
  assertObject(manifest, "RELEASE_OCI_ATTESTATION_MANIFEST_INVALID");
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== OCI_MANIFEST ||
    manifest.artifactType !== ATTESTATION_ARTIFACT_TYPE
  ) {
    throw evidenceError("RELEASE_OCI_ATTESTATION_MANIFEST_INVALID");
  }
  assertDescriptor(manifest.config, "RELEASE_OCI_ATTESTATION_CONFIG_INVALID");
  if (
    manifest.config.mediaType !== OCI_EMPTY_CONFIG ||
    manifest.config.digest !== OCI_EMPTY_CONFIG_DIGEST ||
    manifest.config.size !== 2
  ) {
    throw evidenceError("RELEASE_OCI_ATTESTATION_CONFIG_INVALID");
  }
  assertDescriptor(manifest.subject, "RELEASE_OCI_ATTESTATION_SUBJECT_INVALID");
  if (
    manifest.subject.mediaType !== OCI_MANIFEST ||
    manifest.subject.digest !== expectedManifestDigest ||
    manifest.subject.size <= 0
  ) {
    throw evidenceError("RELEASE_OCI_ATTESTATION_SUBJECT_INVALID");
  }
  if (!Array.isArray(manifest.layers)) {
    throw evidenceError("RELEASE_OCI_ATTESTATION_MANIFEST_INVALID");
  }
  const sbomLayers = manifest.layers.filter(
    (layer) =>
      layer.mediaType === IN_TOTO_LAYER &&
      layer.annotations?.[PREDICATE_TYPE_ANNOTATION] === SPDX_PREDICATE,
  );
  if (sbomLayers.length !== 1) throw evidenceError("RELEASE_OCI_SBOM_LAYER_INVALID");
  assertDescriptor(sbomLayers[0], "RELEASE_OCI_SBOM_LAYER_INVALID");
  return sbomLayers[0];
}

export function validateSpdxStatement(
  statement,
  expectedManifestDigest,
  { allowEmptySubject = false } = {},
) {
  assertObject(statement, "RELEASE_SPDX_STATEMENT_INVALID");
  if (!IN_TOTO_STATEMENTS.has(statement._type) || statement.predicateType !== SPDX_PREDICATE) {
    throw evidenceError("RELEASE_SPDX_STATEMENT_INVALID");
  }
  if (
    !Array.isArray(statement.subject) ||
    (!allowEmptySubject && statement.subject.length !== 1) ||
    (allowEmptySubject && ![0, 1].includes(statement.subject.length))
  ) {
    throw evidenceError("RELEASE_SPDX_SUBJECT_INVALID");
  }
  const subjectDigest = statement.subject[0]?.digest?.sha256;
  if (statement.subject.length === 1 && `sha256:${subjectDigest}` !== expectedManifestDigest) {
    throw evidenceError("RELEASE_SPDX_SUBJECT_INVALID");
  }
  validateSpdxDocument(statement.predicate);
}

export function validateSpdxDocument(document) {
  assertObject(document, "RELEASE_SPDX_DOCUMENT_INVALID");
  if (
    !["SPDX-2.2", "SPDX-2.3"].includes(document.spdxVersion) ||
    document.SPDXID !== "SPDXRef-DOCUMENT" ||
    document.dataLicense !== "CC0-1.0" ||
    typeof document.documentNamespace !== "string" ||
    !Array.isArray(document.packages) ||
    document.packages.length === 0 ||
    !Array.isArray(document.relationships) ||
    document.relationships.length === 0
  ) {
    throw evidenceError("RELEASE_SPDX_DOCUMENT_INVALID");
  }
  const packageIds = document.packages.map((entry) => entry?.SPDXID);
  if (
    packageIds.some((value) => typeof value !== "string") ||
    new Set(packageIds).size !== packageIds.length
  ) {
    throw evidenceError("RELEASE_SPDX_PACKAGE_SET_INVALID");
  }
  const fileIds = (document.files ?? []).map((entry) => entry?.SPDXID);
  if (
    !Array.isArray(document.files ?? []) ||
    fileIds.some((value) => typeof value !== "string") ||
    new Set(fileIds).size !== fileIds.length
  ) {
    throw evidenceError("RELEASE_SPDX_FILE_SET_INVALID");
  }
  const externalDocumentIds = new Set(
    (document.externalDocumentRefs ?? []).map(({ externalDocumentId }) => externalDocumentId),
  );
  if (
    !Array.isArray(document.externalDocumentRefs ?? []) ||
    [...externalDocumentIds].some((value) => typeof value !== "string") ||
    externalDocumentIds.size !== (document.externalDocumentRefs ?? []).length
  ) {
    throw evidenceError("RELEASE_SPDX_EXTERNAL_DOCUMENT_SET_INVALID");
  }
  const localElementIds = new Set([document.SPDXID, ...packageIds, ...fileIds]);
  for (const relationship of document.relationships) {
    if (
      typeof relationship?.spdxElementId !== "string" ||
      typeof relationship?.relatedSpdxElement !== "string" ||
      typeof relationship?.relationshipType !== "string" ||
      !isKnownSpdxElement(relationship.spdxElementId, localElementIds, externalDocumentIds) ||
      !isKnownSpdxElement(relationship.relatedSpdxElement, localElementIds, externalDocumentIds)
    ) {
      throw evidenceError("RELEASE_SPDX_RELATIONSHIP_INVALID");
    }
  }
  return document;
}

function isKnownSpdxElement(value, localElementIds, externalDocumentIds) {
  if (value === "NONE" || value === "NOASSERTION" || localElementIds.has(value)) return true;
  const external = /^(DocumentRef-[^:]+):SPDXRef-.+$/u.exec(value);
  return external ? externalDocumentIds.has(external[1]) : false;
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

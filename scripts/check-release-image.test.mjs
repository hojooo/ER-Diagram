import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILDKIT_SBOM_GENERATOR,
  inspectOciLayout,
  requiredOciMetadata,
  stableVersionFromTag,
} from "./release-image-evidence.mjs";

const VERSION = "1.2.3";
const REVISION = "0123456789abcdef0123456789abcdef01234567";

test("pins the BuildKit SPDX generator by immutable digest", () => {
  assert.match(
    BUILDKIT_SBOM_GENERATOR,
    /^docker\.io\/docker\/buildkit-syft-scanner@sha256:[0-9a-f]{64}$/u,
  );
  const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
  assert.ok(workflow.includes(BUILDKIT_SBOM_GENERATOR));
  for (const requiredPolicy of [
    "outputs: type=registry,oci-mediatypes=true,oci-artifact=true",
    "provenance: false",
    `sbom: generator=\${{ env.SBOM_GENERATOR }}`,
    "prepare-release-sbom-assets.mjs remote-spdx",
    "prepare-release-sbom-assets.mjs finalize",
    "prepare-release-sbom-assets.mjs compare",
  ]) {
    assert.ok(workflow.includes(requiredPolicy), `Missing release policy: ${requiredPolicy}`);
  }
});

test("requires exact approval before tag publication and pins dispatch candidates", () => {
  const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
  for (const requiredPolicy of [
    "expectedRevision:",
    "RELEASE_EXPECTED_REVISION:",
    "RELEASE_APPROVED_VERSION:",
    "RELEASE_APPROVED_REVISION:",
    "node scripts/check-release-approval.mjs",
    "pnpm test:release",
    "needs.validate.outputs.version",
    "needs.validate.outputs.revision",
  ]) {
    assert.ok(
      workflow.includes(requiredPolicy),
      `Missing release approval policy: ${requiredPolicy}`,
    );
  }
  assert.ok(
    workflow.indexOf("node scripts/check-release-approval.mjs") <
      workflow.indexOf("docker/login-action"),
    "Candidate approval must precede GHCR authentication",
  );
});

test("accepts stable tags only", () => {
  assert.equal(stableVersionFromTag("v1.2.3"), VERSION);
  for (const invalid of ["1.2.3", "v1.2", "v01.2.3", "v1.2.3-rc.1", "v1.2.3+1"]) {
    assert.throws(() => stableVersionFromTag(invalid));
  }
});

test("validates exact multi-architecture OCI metadata and platform inventory", () => {
  const fixture = createLayout();
  try {
    const evidence = inspectOciLayout(fixture.directory, {
      version: VERSION,
      revision: REVISION,
    });
    assert.deepEqual(
      evidence.platforms.map(({ platform }) => platform),
      ["linux/amd64", "linux/arm64"],
    );
    assert.ok(evidence.platforms.every(({ spdxVersion }) => spdxVersion === "SPDX-2.3"));
    assert.deepEqual(structuredClone(evidence), evidence);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for missing platforms, metadata drift, and tampered blobs", () => {
  for (const mutation of [
    "MISSING_ARM64",
    "ROOT_ANNOTATION",
    "CONFIG_LABEL",
    "BLOB_HASH",
    "MISSING_ATTESTATION",
    "ATTESTATION_SUBJECT",
    "SPDX_VERSION",
    "EXTRA_ATTESTATION",
    "MANIFEST_SUBJECT",
    "SPDX_RELATIONSHIP_TARGET",
  ]) {
    const fixture = createLayout(mutation);
    try {
      assert.throws(() =>
        inspectOciLayout(fixture.directory, { version: VERSION, revision: REVISION }),
      );
    } finally {
      fixture.cleanup();
    }
  }
});

function createLayout(mutation) {
  const directory = mkdtempSync(join(tmpdir(), "er-diagram-oci-layout-"));
  mkdirSync(join(directory, "blobs", "sha256"), { recursive: true });
  const metadata = requiredOciMetadata({ version: VERSION, revision: REVISION });
  const manifests = ["amd64", "arm64"].map((architecture) => {
    const labels = { ...metadata };
    if (mutation === "CONFIG_LABEL" && architecture === "amd64") {
      labels["org.opencontainers.image.version"] = "9.9.9";
    }
    const config = writeBlob(directory, {
      architecture,
      os: "linux",
      config: {
        User: "node",
        Cmd: ["node", "dist/production-entrypoint.js"],
        Labels: labels,
      },
    });
    const manifest = writeBlob(directory, {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        ...config,
      },
      layers: [],
      annotations: metadata,
    });
    return {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      ...manifest,
      platform: { os: "linux", architecture },
    };
  });
  if (mutation === "MISSING_ARM64") manifests.pop();
  const attestationConfig = writeBlob(directory, {});
  const attestations = manifests.map((imageDescriptor, index) => {
    const architecture = imageDescriptor.platform.architecture;
    const subjectDigest =
      mutation === "ATTESTATION_SUBJECT" && index === 0
        ? "f".repeat(64)
        : imageDescriptor.digest.split(":")[1];
    const statement = writeBlob(directory, {
      _type: "https://in-toto.io/Statement/v0.1",
      predicateType: "https://spdx.dev/Document",
      subject: [
        {
          name: `pkg:docker/hojooo/er-diagram@${imageDescriptor.digest}?platform=linux%2F${architecture}`,
          digest: { sha256: subjectDigest },
        },
      ],
      predicate: {
        SPDXID: "SPDXRef-DOCUMENT",
        creationInfo: {
          created: "2026-09-01T00:00:00Z",
          creators: ["Tool: syft-test"],
        },
        dataLicense: "CC0-1.0",
        documentNamespace: `https://example.invalid/spdx/${architecture}`,
        name: `er-diagram-${architecture}`,
        packages: [
          {
            SPDXID: `SPDXRef-Package-${architecture}`,
            downloadLocation: "NOASSERTION",
            filesAnalyzed: false,
            licenseConcluded: "NOASSERTION",
            licenseDeclared: "NOASSERTION",
            name: "node",
            versionInfo: "24.14.0",
          },
        ],
        relationships: [
          {
            relatedSpdxElement:
              mutation === "SPDX_RELATIONSHIP_TARGET" && index === 0
                ? "SPDXRef-Package-missing"
                : `SPDXRef-Package-${architecture}`,
            relationshipType: "DESCRIBES",
            spdxElementId: "SPDXRef-DOCUMENT",
          },
        ],
        spdxVersion: mutation === "SPDX_VERSION" && index === 0 ? "SPDX-9.9" : "SPDX-2.3",
      },
    });
    const manifest = writeBlob(directory, {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.docker.attestation.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.empty.v1+json",
        ...attestationConfig,
      },
      subject: {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest:
          mutation === "MANIFEST_SUBJECT" && index === 0
            ? `sha256:${"f".repeat(64)}`
            : imageDescriptor.digest,
        size: imageDescriptor.size,
      },
      layers: [
        {
          mediaType: "application/vnd.in-toto+json",
          ...statement,
          annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
        },
      ],
    });
    return {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      ...manifest,
      annotations: {
        "vnd.docker.reference.digest": imageDescriptor.digest,
        "vnd.docker.reference.type": "attestation-manifest",
      },
      platform: { os: "unknown", architecture: "unknown" },
    };
  });
  if (mutation === "MISSING_ATTESTATION") attestations.pop();
  if (mutation === "EXTRA_ATTESTATION") attestations.push({ ...attestations[0] });
  const annotations = { ...metadata };
  if (mutation === "ROOT_ANNOTATION") {
    annotations["org.opencontainers.image.source"] = "https://example.invalid/repository";
  }
  const imageIndex = writeBlob(directory, {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [...manifests, ...attestations],
    annotations,
  });
  writeFileSync(
    join(directory, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.index.v1+json",
          ...imageIndex,
          annotations: { "org.opencontainers.image.created": "2026-09-01T00:00:00Z" },
        },
      ],
    }),
  );
  writeFileSync(join(directory, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n');
  if (mutation === "BLOB_HASH") {
    const digest = manifests[0].digest.split(":")[1];
    writeFileSync(join(directory, "blobs", "sha256", digest), "tampered");
  }
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function writeBlob(directory, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(directory, "blobs", "sha256", digest), bytes);
  return { digest: `sha256:${digest}`, size: bytes.length };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectOciLayout,
  requiredOciMetadata,
  stableVersionFromTag,
} from "./release-image-evidence.mjs";

const VERSION = "1.2.3";
const REVISION = "0123456789abcdef0123456789abcdef01234567";

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
    assert.deepEqual(structuredClone(evidence), evidence);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for missing platforms, metadata drift, and tampered blobs", () => {
  for (const mutation of ["MISSING_ARM64", "ROOT_ANNOTATION", "CONFIG_LABEL", "BLOB_HASH"]) {
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
  const annotations = { ...metadata };
  if (mutation === "ROOT_ANNOTATION") {
    annotations["org.opencontainers.image.source"] = "https://example.invalid/repository";
  }
  const imageIndex = writeBlob(directory, {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
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

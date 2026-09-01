import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareReleaseAssetDirectories,
  finalizeReleaseAssets,
  releaseAssetNames,
  ReleaseSbomAssetError,
  verifyIntegrity,
  writeSpdxReleaseAssets,
} from "./release-sbom-assets.mjs";

const VERSION = "1.2.3";

test("verifies npm sha512 integrity and rejects tampering", () => {
  const bytes = Buffer.from("exact-source-archive");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.doesNotThrow(() => verifyIntegrity(bytes, integrity));
  assert.throws(
    () => verifyIntegrity(Buffer.from("tampered"), integrity),
    (error) =>
      error instanceof ReleaseSbomAssetError &&
      error.code === "RELEASE_EPL_SOURCE_INTEGRITY_MISMATCH",
  );
});

test("writes deterministic platform SPDX assets", () => {
  const directory = mkdtempSync(join(tmpdir(), "er-diagram-spdx-assets-"));
  try {
    const document = spdxFixture();
    const written = writeSpdxReleaseAssets({
      documentsByPlatform: new Map([
        ["linux/amd64", document],
        ["linux/arm64", structuredClone(document)],
      ]),
      outputDirectory: directory,
      version: VERSION,
    });
    assert.deepEqual(
      written.map(({ filename }) => filename),
      [
        `er-diagram-${VERSION}-linux-amd64.spdx.json`,
        `er-diagram-${VERSION}-linux-arm64.spdx.json`,
      ],
    );
    assert.equal(
      readFileSync(join(directory, written[0].filename), "utf8"),
      readFileSync(join(directory, written[1].filename), "utf8"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("finalizes an exact asset set and rejects replay drift", () => {
  const expected = mkdtempSync(join(tmpdir(), "er-diagram-release-assets-"));
  const actual = mkdtempSync(join(tmpdir(), "er-diagram-release-assets-copy-"));
  const names = releaseAssetNames(VERSION);
  try {
    for (const filename of [
      names.cyclonedx,
      names.eplLicense,
      names.eplSource,
      ...Object.values(names.spdx),
    ]) {
      writeFileSync(join(expected, filename), `${filename}\n`);
      writeFileSync(join(actual, filename), `${filename}\n`);
    }
    const finalized = finalizeReleaseAssets({ outputDirectory: expected, version: VERSION });
    writeFileSync(join(actual, names.sha256sums), finalized.text);
    assert.doesNotThrow(() => compareReleaseAssetDirectories(expected, actual));

    writeFileSync(join(actual, names.eplSource), "different\n");
    assert.throws(
      () => compareReleaseAssetDirectories(expected, actual),
      (error) =>
        error instanceof ReleaseSbomAssetError && error.code === "RELEASE_SBOM_ASSET_CONFLICT",
    );
  } finally {
    rmSync(expected, { recursive: true, force: true });
    rmSync(actual, { recursive: true, force: true });
  }
});

function spdxFixture() {
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: "2026-09-01T00:00:00Z",
      creators: ["Tool: syft-test"],
    },
    dataLicense: "CC0-1.0",
    documentNamespace: "https://example.invalid/sbom",
    name: "er-diagram",
    packages: [
      {
        SPDXID: "SPDXRef-Package-node",
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
        relatedSpdxElement: "SPDXRef-Package-node",
        relationshipType: "DESCRIBES",
        spdxElementId: "SPDXRef-DOCUMENT",
      },
    ],
    spdxVersion: "SPDX-2.3",
  };
}

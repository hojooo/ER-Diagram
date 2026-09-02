import assert from "node:assert/strict";
import test from "node:test";

import {
  PublishedReleaseError,
  validatePublishedReleaseEvidence,
} from "./verify-published-release.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;

function evidence() {
  return {
    version: "0.1.0",
    revision: REVISION,
    exactImage: {
      digest: DIGEST,
      version: "0.1.0",
      sourceRevision: REVISION,
      platforms: ["linux/amd64", "linux/arm64"],
    },
    latestImage: {
      digest: DIGEST,
      version: "0.1.0",
      sourceRevision: REVISION,
      platforms: ["linux/amd64", "linux/arm64"],
    },
    release: {
      tagName: "v0.1.0",
      url: "https://github.com/hojooo/ER-Diagram/releases/tag/v0.1.0",
      body: `source ${REVISION}\nimage ghcr.io/hojooo/er-diagram:0.1.0\ndigest ${DIGEST}`,
    },
    assets: {
      files: [
        "SHA256SUMS",
        "elkjs-0.12.0-EPL-2.0.txt",
        "elkjs-0.12.0-source.tgz",
        "er-diagram-0.1.0-linux-amd64.spdx.json",
        "er-diagram-0.1.0-linux-arm64.spdx.json",
        "er-diagram-0.1.0.cdx.json",
      ],
      sha256sumsSha256: "b".repeat(64),
    },
  };
}

test("accepts exact public image and GitHub Release evidence", () => {
  assert.deepEqual(validatePublishedReleaseEvidence(evidence()), {
    digest: DIGEST,
    platforms: ["linux/amd64", "linux/arm64"],
    revision: REVISION,
    releaseUrl: "https://github.com/hojooo/ER-Diagram/releases/tag/v0.1.0",
    tag: "v0.1.0",
    version: "0.1.0",
  });
});

test("fails closed when latest, release body, or asset evidence drifts", () => {
  const mutations = [
    (value) => {
      value.latestImage.digest = `sha256:${"c".repeat(64)}`;
    },
    (value) => {
      value.release.body = "different";
    },
    (value) => {
      value.assets.files.pop();
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(evidence());
    mutate(value);
    assert.throws(
      () => validatePublishedReleaseEvidence(value),
      (error) =>
        error instanceof PublishedReleaseError &&
        error.code === "RELEASE_PUBLISHED_EVIDENCE_INVALID",
    );
  }
});

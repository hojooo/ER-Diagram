import { describe, expect, it } from "vitest";

import {
  P0_RELEASE_EVIDENCE_PROFILE_HASH,
  P0_RELEASE_EVIDENCE_VERSION,
  P0_RELEASE_IMAGE,
  P0_RELEASE_TAG,
  P0_RELEASE_VERSION,
  p0ReleaseEvidenceProfile,
} from "../src/index.js";

const EXPECTED_PROFILE_HASH = "ea313af9adfdd02cbafa11dcc31e4009d786dd11d1d7a4802f94636f0a2f4aab";

describe("versioned P0 release evidence profile", () => {
  it("pins the first public release identity and OrbStack boundary", () => {
    expect(P0_RELEASE_EVIDENCE_VERSION).toBe(1);
    expect(P0_RELEASE_VERSION).toBe("0.1.0");
    expect(P0_RELEASE_TAG).toBe("v0.1.0");
    expect(P0_RELEASE_IMAGE).toBe("ghcr.io/hojooo/er-diagram:0.1.0");
    expect(p0ReleaseEvidenceProfile.release).toEqual({
      version: P0_RELEASE_VERSION,
      tag: P0_RELEASE_TAG,
      imageReference: P0_RELEASE_IMAGE,
      requiredDockerContext: "orbstack",
    });
    expect(p0ReleaseEvidenceProfile.mapping).toEqual({
      imageVersionFromTag: "REMOVE_SINGLE_V_PREFIX",
      releaseRevision: "FULL_LOWERCASE_COMMIT_SHA",
      workspaceVersionOwnsRelease: false,
    });
  });

  it("keeps the whole-volume inventory and assertion order deterministic", () => {
    expect(p0ReleaseEvidenceProfile.inventory).toEqual({
      projects: 2,
      schemaRevisions: 4,
      diagramLayouts: 1,
      importArtifacts: 1,
      visualCommandReceipts: 1,
      appMetadata: 1,
      drizzleMigrations: 2,
    });
    expect(p0ReleaseEvidenceProfile.assertions).toEqual(
      [...p0ReleaseEvidenceProfile.assertions].sort(compareCodeUnits),
    );
    expect(new Set(p0ReleaseEvidenceProfile.assertions).size).toBe(
      p0ReleaseEvidenceProfile.assertions.length,
    );
    expect(p0ReleaseEvidenceProfile.evidence.requiredFields).toEqual(
      [...p0ReleaseEvidenceProfile.evidence.requiredFields].sort(compareCodeUnits),
    );
    expect(p0ReleaseEvidenceProfile.evidence.forbiddenContent).toEqual(
      [...p0ReleaseEvidenceProfile.evidence.forbiddenContent].sort(compareCodeUnits),
    );
  });

  it("publishes cloneable plain data with a reviewed golden hash", () => {
    expect(P0_RELEASE_EVIDENCE_PROFILE_HASH).toBe(EXPECTED_PROFILE_HASH);
    expect(structuredClone(p0ReleaseEvidenceProfile)).toEqual(p0ReleaseEvidenceProfile);
    expect(JSON.parse(JSON.stringify(p0ReleaseEvidenceProfile))).toEqual(p0ReleaseEvidenceProfile);
  });
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

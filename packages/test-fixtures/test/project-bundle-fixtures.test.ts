import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROJECT_BUNDLE_FIXTURE_SET_HASH,
  PROJECT_BUNDLE_FIXTURE_VERSION,
  projectBundleFixture,
} from "../src/index.js";

describe("versioned portable project bundle fixture", () => {
  it("pins invalid-current, last-valid, layout and retained SQL evidence", () => {
    expect(PROJECT_BUNDLE_FIXTURE_VERSION).toBe(1);
    expect(PROJECT_BUNDLE_FIXTURE_SET_HASH).toBe(sha256(JSON.stringify(projectBundleFixture)));
    expect(projectBundleFixture.current.sourceHash).toBe(
      sha256(projectBundleFixture.current.source),
    );
    expect(projectBundleFixture.lastValid.sourceHash).toBe(
      sha256(projectBundleFixture.lastValid.source),
    );
    expect(projectBundleFixture.retainedSqlHash).toBe(sha256(projectBundleFixture.retainedSql));
    expect(projectBundleFixture.current.source).toContain(projectBundleFixture.lastValid.source);
    expect(projectBundleFixture.current.revisionNo).toBe(3);
    expect(projectBundleFixture.lastValid.revisionNo).toBe(1);
    expect(projectBundleFixture.retainedSql).toContain(projectBundleFixture.rowSentinel);
    expect(structuredClone(projectBundleFixture)).toEqual(projectBundleFixture);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

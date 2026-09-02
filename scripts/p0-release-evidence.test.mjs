import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInventory,
  assertOwnedResourceName,
  assertRedactedText,
  canonicalReleaseEvidence,
  P0ReleaseGateError,
} from "./p0-release-evidence.mjs";

const inventory = {
  projects: 2,
  schemaRevisions: 4,
  diagramLayouts: 1,
  importArtifacts: 1,
  visualCommandReceipts: 1,
  appMetadata: 1,
  drizzleMigrations: 2,
};

test("limits cleanup to gate-owned resource names", () => {
  const prefix = "erdiagram-p0-release-123456";
  assert.equal(assertOwnedResourceName(`${prefix}-source`, prefix), `${prefix}-source`);
  for (const name of ["source", prefix, `${prefix}/source`, "erdiagram-p0-release-other-source"]) {
    assert.throws(
      () => assertOwnedResourceName(name, prefix),
      (error) =>
        error instanceof P0ReleaseGateError && error.code === "P0_RELEASE_CLEANUP_SCOPE_INVALID",
    );
  }
});

test("checks exact source-free inventory and log redaction", () => {
  assert.deepEqual(assertInventory({ ...inventory, ignored: 1 }, inventory), inventory);
  assertRedactedText('{"operation":"PROJECT_CREATE"}', ["PRIVATE_DBML", "PRIVATE_SQL"]);
  assert.throws(
    () => assertRedactedText("log PRIVATE_SQL", ["PRIVATE_SQL"]),
    (error) =>
      error instanceof P0ReleaseGateError && error.code === "P0_RELEASE_SENSITIVE_EVIDENCE_EXPOSED",
  );
});

test("serializes reviewed release evidence canonically", () => {
  const hash = "a".repeat(64);
  const value = {
    version: "0.1.0",
    revision: "b".repeat(40),
    releaseState: "P0_RELEASE_CANDIDATE",
    profileHash: hash,
    inventory,
    imageReference: "ghcr.io/hojooo/er-diagram:0.1.0",
    imageConfigDigest: hash,
    evidenceVersion: 1,
    candidateDatabaseSha256: hash,
    backupHash: hash,
    assertions: ["A", "B"],
    sourceDatabaseSha256: hash,
    recoveryPlanHash: hash,
  };
  const first = canonicalReleaseEvidence(value);
  const second = canonicalReleaseEvidence(structuredClone(value));
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.ok(first.indexOf('"assertions"') < first.indexOf('"backupHash"'));
});

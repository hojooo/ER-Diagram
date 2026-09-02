import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReleaseCandidateArguments,
  ReleaseCandidateError,
  validateCandidateCheckoutRevision,
  validateReleaseApproval,
} from "./release-candidate.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

test("parses an exact optional release version and revision", () => {
  assert.deepEqual(
    parseReleaseCandidateArguments([], {
      defaultRevision: REVISION,
      defaultVersion: "0.0.0",
    }),
    { revision: REVISION, version: "0.0.0" },
  );
  assert.deepEqual(
    parseReleaseCandidateArguments(["--version", "0.1.0", "--revision", REVISION], {
      defaultRevision: "f".repeat(40),
      defaultVersion: "0.0.0",
    }),
    { revision: REVISION, version: "0.1.0" },
  );
});

test("requires the release CLI revision to equal the checked-out commit", () => {
  assert.equal(validateCandidateCheckoutRevision(REVISION, REVISION), REVISION);
  assert.throws(
    () => validateCandidateCheckoutRevision(REVISION, "f".repeat(40)),
    (error) =>
      error instanceof ReleaseCandidateError &&
      error.code === "RELEASE_CANDIDATE_REVISION_MISMATCH",
  );
});

test("rejects malformed, duplicate, and unknown release arguments", () => {
  for (const argv of [
    ["--version", "v0.1.0"],
    ["--version", "0.1.0-rc.1"],
    ["--revision", "ABC"],
    ["--version", "0.1.0", "--version", "0.1.1"],
    ["--unknown", "value"],
  ]) {
    assert.throws(
      () =>
        parseReleaseCandidateArguments(argv, {
          defaultRevision: REVISION,
          defaultVersion: "0.0.0",
        }),
      (error) =>
        error instanceof ReleaseCandidateError &&
        error.code === "RELEASE_CANDIDATE_ARGUMENT_INVALID",
    );
  }
});

test("requires exact repository approval for tag publication", () => {
  assert.deepEqual(
    validateReleaseApproval({
      eventName: "push",
      version: "0.1.0",
      revision: REVISION,
      expectedRevision: "",
      approvedVersion: "0.1.0",
      approvedRevision: REVISION,
    }),
    { approvalRequired: true, revision: REVISION, version: "0.1.0" },
  );

  for (const mismatch of [
    { approvedVersion: "", approvedRevision: REVISION },
    { approvedVersion: "0.1.1", approvedRevision: REVISION },
    { approvedVersion: "0.1.0", approvedRevision: "f".repeat(40) },
  ]) {
    assert.throws(
      () =>
        validateReleaseApproval({
          eventName: "push",
          version: "0.1.0",
          revision: REVISION,
          expectedRevision: "",
          ...mismatch,
        }),
      (error) =>
        error instanceof ReleaseCandidateError && error.code === "RELEASE_CANDIDATE_NOT_APPROVED",
    );
  }
});

test("bypasses repository approval for dry runs but pins the checked-out revision", () => {
  assert.deepEqual(
    validateReleaseApproval({
      eventName: "workflow_dispatch",
      version: "0.1.0",
      revision: REVISION,
      expectedRevision: REVISION,
      approvedVersion: "",
      approvedRevision: "",
    }),
    { approvalRequired: false, revision: REVISION, version: "0.1.0" },
  );
  assert.throws(
    () =>
      validateReleaseApproval({
        eventName: "workflow_dispatch",
        version: "0.1.0",
        revision: REVISION,
        expectedRevision: "f".repeat(40),
        approvedVersion: "",
        approvedRevision: "",
      }),
    (error) =>
      error instanceof ReleaseCandidateError &&
      error.code === "RELEASE_CANDIDATE_REVISION_MISMATCH",
  );
});

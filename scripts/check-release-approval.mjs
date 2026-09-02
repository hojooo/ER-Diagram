#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { ReleaseCandidateError, validateReleaseApproval } from "./release-candidate.mjs";

export function checkReleaseApproval(environment) {
  return validateReleaseApproval({
    eventName: environment.RELEASE_EVENT_NAME ?? "",
    version: environment.RELEASE_VERSION ?? "",
    revision: environment.RELEASE_REVISION ?? "",
    expectedRevision: environment.RELEASE_EXPECTED_REVISION ?? "",
    approvedVersion: environment.RELEASE_APPROVED_VERSION ?? "",
    approvedRevision: environment.RELEASE_APPROVED_REVISION ?? "",
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.stdout.write(`${JSON.stringify(checkReleaseApproval(process.env))}\n`);
  } catch (error) {
    const code =
      error instanceof ReleaseCandidateError ? error.code : "RELEASE_CANDIDATE_NOT_APPROVED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

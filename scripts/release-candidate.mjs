const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export class ReleaseCandidateError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseCandidateError";
    this.code = code;
  }
}

export function parseReleaseCandidateArguments(argv, defaults) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !["--revision", "--version"].includes(option) ||
      typeof value !== "string" ||
      value.length === 0 ||
      values.has(option)
    ) {
      invalidArguments();
    }
    values.set(option, value);
  }
  const version = values.get("--version") ?? defaults?.defaultVersion;
  const revision = values.get("--revision") ?? defaults?.defaultRevision;
  assertStableReleaseVersion(version, "RELEASE_CANDIDATE_ARGUMENT_INVALID");
  assertReleaseRevision(revision, "RELEASE_CANDIDATE_ARGUMENT_INVALID");
  return Object.freeze({ revision, version });
}

export function validateReleaseApproval({
  approvedRevision,
  approvedVersion,
  eventName,
  expectedRevision,
  revision,
  version,
}) {
  assertStableReleaseVersion(version, "RELEASE_CANDIDATE_ARGUMENT_INVALID");
  assertReleaseRevision(revision, "RELEASE_CANDIDATE_ARGUMENT_INVALID");
  if (eventName === "workflow_dispatch") {
    assertReleaseRevision(expectedRevision, "RELEASE_CANDIDATE_REVISION_MISMATCH");
    if (expectedRevision !== revision) {
      throw new ReleaseCandidateError("RELEASE_CANDIDATE_REVISION_MISMATCH");
    }
    return Object.freeze({ approvalRequired: false, revision, version });
  }
  if (eventName !== "push") invalidArguments();
  if (approvedVersion !== version || approvedRevision !== revision) {
    throw new ReleaseCandidateError("RELEASE_CANDIDATE_NOT_APPROVED");
  }
  return Object.freeze({ approvalRequired: true, revision, version });
}

export function validateCandidateCheckoutRevision(candidateRevision, checkoutRevision) {
  assertReleaseRevision(candidateRevision, "RELEASE_CANDIDATE_ARGUMENT_INVALID");
  assertReleaseRevision(checkoutRevision, "RELEASE_CANDIDATE_REVISION_MISMATCH");
  if (candidateRevision !== checkoutRevision) {
    throw new ReleaseCandidateError("RELEASE_CANDIDATE_REVISION_MISMATCH");
  }
  return checkoutRevision;
}

export function assertStableReleaseVersion(value, code = "RELEASE_CANDIDATE_ARGUMENT_INVALID") {
  if (!STABLE_VERSION_PATTERN.test(value ?? "")) throw new ReleaseCandidateError(code);
}

export function assertReleaseRevision(value, code = "RELEASE_CANDIDATE_ARGUMENT_INVALID") {
  if (!REVISION_PATTERN.test(value ?? "")) throw new ReleaseCandidateError(code);
}

function invalidArguments() {
  throw new ReleaseCandidateError("RELEASE_CANDIDATE_ARGUMENT_INVALID");
}

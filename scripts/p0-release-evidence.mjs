import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class P0ReleaseGateError extends Error {
  constructor(code = "P0_RELEASE_GATE_FAILED") {
    super(code);
    this.name = "P0ReleaseGateError";
    this.code = code;
  }
}

export function assertOwnedResourceName(name, prefix) {
  if (
    typeof name !== "string" ||
    typeof prefix !== "string" ||
    prefix.length < 16 ||
    !name.startsWith(`${prefix}-`) ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(name)
  ) {
    throw new P0ReleaseGateError("P0_RELEASE_CLEANUP_SCOPE_INVALID");
  }
  return name;
}

export function assertInventory(actual, expected) {
  const keys = [
    "projects",
    "schemaRevisions",
    "diagramLayouts",
    "importArtifacts",
    "visualCommandReceipts",
    "appMetadata",
    "drizzleMigrations",
  ];
  const normalized = Object.fromEntries(keys.map((key) => [key, actual?.[key]]));
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new P0ReleaseGateError("P0_RELEASE_INVENTORY_MISMATCH");
  }
  return Object.freeze(normalized);
}

export function assertRedactedText(value, sentinels) {
  if (typeof value !== "string") {
    throw new P0ReleaseGateError("P0_RELEASE_EVIDENCE_INVALID");
  }
  for (const sentinel of sentinels) {
    if (typeof sentinel !== "string" || sentinel.length === 0 || value.includes(sentinel)) {
      throw new P0ReleaseGateError("P0_RELEASE_SENSITIVE_EVIDENCE_EXPOSED");
    }
  }
}

export function canonicalReleaseEvidence(value) {
  validateReleaseEvidence(value);
  return `${JSON.stringify(sortJson(value))}\n`;
}

export function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateReleaseEvidence(value) {
  const hashes = [
    value?.imageConfigDigest,
    value?.backupHash,
    value?.recoveryPlanHash,
    value?.sourceDatabaseSha256,
    value?.candidateDatabaseSha256,
    value?.profileHash,
  ];
  if (
    value?.evidenceVersion !== 1 ||
    value?.releaseState !== "P0_RELEASE_CANDIDATE" ||
    value?.version !== "0.1.0" ||
    value?.imageReference !== "ghcr.io/hojooo/er-diagram:0.1.0" ||
    !/^[0-9a-f]{40}$/u.test(value?.revision ?? "") ||
    !hashes.every((hash) => SHA256_PATTERN.test(hash ?? "")) ||
    !Array.isArray(value?.assertions) ||
    value.assertions.length === 0 ||
    JSON.stringify(value.assertions) !==
      JSON.stringify([...value.assertions].sort(compareCodeUnits))
  ) {
    throw new P0ReleaseGateError("P0_RELEASE_EVIDENCE_INVALID");
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

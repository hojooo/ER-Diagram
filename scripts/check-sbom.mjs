#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  collectProductionDependencyRecords,
  createCycloneDxSbom,
  SbomEvidenceError,
  validateCycloneDxDocument,
} from "./sbom-evidence.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const identity = {
    imageReference: "ghcr.io/hojooo/er-diagram:0.0.0",
    revision,
    version: "0.0.0",
  };
  const records = collectProductionDependencyRecords(repositoryRoot);
  const first = createCycloneDxSbom({ ...identity, records });
  const second = createCycloneDxSbom({ ...identity, records });
  assert.equal(first.text, second.text, "CycloneDX output must be byte-identical");
  validateCycloneDxDocument(first.document, identity);

  const componentNames = new Set(first.document.components.map(({ name }) => name));
  for (const requiredName of [
    "@er-diagram/core",
    "@er-diagram/server",
    "@er-diagram/web",
    "better-sqlite3",
    "dompurify",
    "elkjs",
  ]) {
    assert.ok(componentNames.has(requiredName), `Missing production component: ${requiredName}`);
  }
  assert.ok(
    !componentNames.has("@cyclonedx/cyclonedx-library"),
    "The development-only CycloneDX generator must not be a production component",
  );

  for (const forbidden of [repositoryRoot, process.env.HOME, '"timestamp"', '"serialNumber"']) {
    if (forbidden) assert.ok(!first.text.includes(forbidden), `Forbidden SBOM value: ${forbidden}`);
  }

  process.stdout.write(
    `${JSON.stringify({ bytes: first.bytes, components: first.componentCount, sha256: first.sha256, status: "ok" })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof SbomEvidenceError ? error.code : "SBOM_CHECK_FAILED"}\n`,
  );
  process.exit(1);
}

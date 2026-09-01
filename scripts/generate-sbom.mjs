#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  collectProductionDependencyRecords,
  createCycloneDxSbom,
  SbomEvidenceError,
} from "./sbom-evidence.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsByName = parseArguments(process.argv.slice(2));

try {
  const output = argumentsByName.get("output");
  const version = argumentsByName.get("version");
  const revision = argumentsByName.get("revision");
  const imageReference = argumentsByName.get("image-reference");
  if (!output || !version || !revision || !imageReference) {
    fail("SBOM_GENERATE_ARGUMENT_INVALID");
  }

  const result = createCycloneDxSbom({
    imageReference,
    records: collectProductionDependencyRecords(repositoryRoot),
    revision,
    version,
  });
  const outputPath = resolve(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, result.text, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(
    `${JSON.stringify({ bytes: result.bytes, components: result.componentCount, sha256: result.sha256, status: "ok" })}\n`,
  );
} catch (error) {
  fail(error instanceof SbomEvidenceError ? error.code : "SBOM_GENERATE_FAILED");
}

function parseArguments(values) {
  if (values.length % 2 !== 0) fail("SBOM_GENERATE_ARGUMENT_INVALID");
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/u, "");
    const value = values[index + 1];
    if (!name || !value || parsed.has(name)) fail("SBOM_GENERATE_ARGUMENT_INVALID");
    parsed.set(name, value);
  }
  return parsed;
}

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

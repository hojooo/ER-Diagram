import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repositoryRoot, "scripts", "check-licenses.mjs");
const fixtureFiles = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  path.join("scripts", "license-inventory.json"),
];

function createFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "er-diagram-license-check-"));

  for (const relativePath of fixtureFiles) {
    const targetPath = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relativePath), targetPath);
  }

  fs.writeFileSync(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "license-check-fixture",
        version: "0.0.0",
        private: true,
        license: "Apache-2.0",
        dependencies: { react: "19.2.8" },
      },
      null,
      2,
    )}\n`,
  );

  return fixtureRoot;
}

function runChecker(fixtureRoot) {
  return spawnSync(process.execPath, [checkerPath, "--root", fixtureRoot], {
    encoding: "utf8",
  });
}

function replaceInFixture(fixtureRoot, relativePath, currentText, replacementText) {
  const targetPath = path.join(fixtureRoot, relativePath);
  const contents = fs.readFileSync(targetPath, "utf8");
  assert.ok(
    contents.includes(currentText),
    `${relativePath} must contain the test mutation target`,
  );
  fs.writeFileSync(targetPath, contents.replace(currentText, replacementText));
}

function expectFailure(mutate, expectedMessage) {
  const fixtureRoot = createFixture();

  try {
    mutate(fixtureRoot);
    const result = runChecker(fixtureRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, expectedMessage);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("accepts a complete pre-install fixture", () => {
  const fixtureRoot = createFixture();

  try {
    const result = runChecker(fixtureRoot);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /pre-install mode/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("rejects unresolved placeholders", () => {
  expectFailure(
    (fixtureRoot) =>
      fs.appendFileSync(path.join(fixtureRoot, "NOTICE"), "\nTODO: replace this notice\n"),
    /unresolved placeholder: TODO/,
  );
});

test("rejects missing copyright and SPDX entries", () => {
  expectFailure((fixtureRoot) => {
    replaceInFixture(fixtureRoot, "NOTICE", "Copyright 2026 hojooo", "");
    replaceInFixture(
      fixtureRoot,
      "THIRD_PARTY_NOTICES.md",
      "SPDX-License-Identifier: Apache-2.0",
      "",
    );
    const manifestPath = path.join(fixtureRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.license;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }, /NOTICE is missing required entry: Copyright 2026 hojooo[\s\S]*missing the project SPDX identifier[\s\S]*must declare SPDX license Apache-2.0/);
});

test("rejects a missing required upstream notice", () => {
  expectFailure(
    (fixtureRoot) =>
      replaceInFixture(
        fixtureRoot,
        "THIRD_PARTY_NOTICES.md",
        "`@playwright/test@1.62.1` — `NOTICE`",
        "`@playwright/test@1.62.1`",
      ),
    /missing the upstream notice entry for @playwright\/test@1\.62\.1/,
  );
});

test("rejects non-exact direct dependency versions", () => {
  expectFailure(
    (fixtureRoot) =>
      replaceInFixture(fixtureRoot, "package.json", '"react": "19.2.8"', '"react": "^19.2.8"'),
    /non-exact dependencies version for react: \^19\.2\.8/,
  );
});

test("rejects unknown inventory licenses", () => {
  expectFailure(
    (fixtureRoot) =>
      replaceInFixture(
        fixtureRoot,
        path.join("scripts", "license-inventory.json"),
        '"name": "react",\n      "version": "19.2.8",\n      "licenseExpression": "MIT"',
        '"name": "react",\n      "version": "19.2.8",\n      "licenseExpression": "UNKNOWN"',
      ),
    /react@19\.2\.8 has an unknown license expression: UNKNOWN/,
  );
});

test("rejects an invalid production license selection", () => {
  expectFailure(
    (fixtureRoot) =>
      replaceInFixture(
        fixtureRoot,
        path.join("scripts", "license-inventory.json"),
        '"selectedLicense": "Apache-2.0",\n      "source": "https://github.com/cure53/DOMPurify"',
        '"selectedLicense": "MIT",\n      "source": "https://github.com/cure53/DOMPurify"',
      ),
    /dompurify@3\.4\.8 selects a forbidden or invalid production license: MIT/,
  );
});

test("rejects @dbml/connector as a direct dependency", () => {
  expectFailure(
    (fixtureRoot) =>
      replaceInFixture(
        fixtureRoot,
        "package.json",
        '"react": "19.2.8"',
        '"react": "19.2.8",\n    "@dbml/connector": "9.1.1"',
      ),
    /declares forbidden P0 dependency @dbml\/connector/,
  );
});

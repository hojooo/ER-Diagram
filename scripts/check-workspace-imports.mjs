import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const workspacePackages = [
  {
    exportName: "contractPackage",
    packageDirectory: "contracts",
    specifier: "@er-diagram/contracts",
  },
  {
    exportName: "corePackage",
    packageDirectory: "core",
    specifier: "@er-diagram/core",
  },
  {
    exportName: "sourceTransformPackage",
    packageDirectory: "source-transform",
    specifier: "@er-diagram/source-transform",
  },
  {
    exportName: "storageSqlitePackage",
    packageDirectory: "storage-sqlite",
    specifier: "@er-diagram/storage-sqlite",
  },
  {
    exportName: "testFixturesPackage",
    packageDirectory: "test-fixtures",
    specifier: "@er-diagram/test-fixtures",
  },
];

let storagePackageExports;

for (const workspacePackage of workspacePackages) {
  const expectedEntrypoint = pathToFileURL(
    path.join(rootDirectory, "packages", workspacePackage.packageDirectory, "dist", "index.js"),
  ).href;
  const resolvedEntrypoint = import.meta.resolve(workspacePackage.specifier);

  assert.equal(
    resolvedEntrypoint,
    expectedEntrypoint,
    `${workspacePackage.specifier} must resolve to its built dist/index.js entrypoint`,
  );

  const packageExports = await import(workspacePackage.specifier);
  assert.equal(
    packageExports[workspacePackage.exportName],
    workspacePackage.specifier,
    `${workspacePackage.specifier} must expose ${workspacePackage.exportName}`,
  );

  if (workspacePackage.specifier === "@er-diagram/storage-sqlite") {
    storagePackageExports = packageExports;
  }
}

assert.ok(storagePackageExports, "@er-diagram/storage-sqlite must be imported");
assert.equal(typeof storagePackageExports.openSqliteStorage, "function");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "er-diagram-built-storage-"));
try {
  const storage = storagePackageExports.openSqliteStorage({
    filename: path.join(temporaryDirectory, "build-smoke.sqlite"),
  });
  try {
    assert.deepEqual(
      storage.database.get("SELECT value FROM app_metadata WHERE key = 'storage_schema_version'"),
      { value: String(storagePackageExports.SQLITE_STORAGE_SCHEMA_VERSION) },
      "built storage package must resolve and apply its bundled migration",
    );
  } finally {
    storage.close();
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

console.log(`Verified ${workspacePackages.length} built workspace package imports.`);

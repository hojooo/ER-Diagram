import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

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
}

console.log(`Verified ${workspacePackages.length} built workspace package imports.`);

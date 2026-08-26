import { describe, expect, it } from "vitest";
import { contractPackage } from "@er-diagram/contracts";
import { corePackage } from "@er-diagram/core";
import { sourceTransformPackage } from "@er-diagram/source-transform";
import { storageSqlitePackage } from "@er-diagram/storage-sqlite";
import { testFixturesPackage } from "@er-diagram/test-fixtures";

describe("workspace bootstrap", () => {
  it("resolves each framework-independent workspace by package name", () => {
    expect([
      contractPackage,
      corePackage,
      sourceTransformPackage,
      storageSqlitePackage,
      testFixturesPackage,
    ]).toEqual([
      "@er-diagram/contracts",
      "@er-diagram/core",
      "@er-diagram/source-transform",
      "@er-diagram/storage-sqlite",
      "@er-diagram/test-fixtures",
    ]);
  });
});

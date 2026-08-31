import { describe, expect, it } from "vitest";

import {
  projectBundleExportRequestSchema,
  projectBundleImportResponseSchema,
  projectBundleLayoutEntryV1Schema,
  projectBundleManifestV1Schema,
  projectBundleSqlImportArtifactEntryV1Schema,
} from "../src/index.js";

const PROJECT_ID = "018f0f87-7b5a-7cc0-8000-000000000001";
const REVISION_ID = "018f0f87-7b5a-7cc0-8000-000000000002";
const ARTIFACT_ID = "018f0f87-7b5a-7cc0-8000-000000000003";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const CREATED_AT = "2026-08-31T01:02:03.000Z";

function diagnosticSummary() {
  return { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" };
}

function manifest() {
  return {
    format: "ER_DIAGRAM_PROJECT_BUNDLE" as const,
    bundleSchemaVersion: 1 as const,
    bundleHash: HASH,
    createdAt: CREATED_AT,
    producer: { parserVersion: "9.1.1" },
    sourceProjectId: PROJECT_ID,
    project: {
      name: "Portable 🚀 schema",
      primaryDialect: "POSTGRESQL" as const,
      parserVersion: "9.1.1",
      schemaRevisionNo: 2,
      layoutRevisionNo: 3,
      currentRevisionNo: 2,
      lastValidRevisionNo: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    reportMode: "REDACTED" as const,
    entries: [
      {
        kind: "SCHEMA_REVISION" as const,
        path: "history/0000000001.dbml",
        bytes: 24,
        sha256: HASH,
        revisionNo: 1,
        validity: "VALID" as const,
        origin: "SOURCE_EDIT" as const,
        parserVersion: "9.1.1",
        diagnosticSummary: diagnosticSummary(),
        createdAt: CREATED_AT,
      },
      {
        kind: "SCHEMA_REVISION" as const,
        path: "history/0000000002.dbml",
        bytes: 31,
        sha256: OTHER_HASH,
        revisionNo: 2,
        validity: "INVALID" as const,
        origin: "SOURCE_EDIT" as const,
        parserVersion: "9.1.1",
        diagnosticSummary: { ...diagnosticSummary(), errors: 1 },
        createdAt: CREATED_AT,
      },
      {
        kind: "DIAGRAM_LAYOUT" as const,
        path: "layouts/0000.json",
        bytes: 80,
        sha256: HASH,
        viewKey: "GLOBAL",
        revisionNo: 3,
      },
      {
        kind: "CURRENT_DBML" as const,
        path: "schema/main.dbml",
        bytes: 31,
        sha256: OTHER_HASH,
      },
    ],
  };
}

function projectState() {
  const currentRevision = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 2,
    source: "Table users { id bigint [pk] }\n",
    sourceHash: OTHER_HASH,
    validity: "INVALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { ...diagnosticSummary(), errors: 1 },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name: "Portable 🚀 schema",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: currentRevision.source,
      draftHash: currentRevision.sourceHash,
      lastValidRevisionId: null,
      parserVersion: "9.1.1",
      schemaRevisionNo: 2,
      layoutRevisionNo: 3,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision: null,
  };
}

describe("portable project bundle contracts", () => {
  it("accepts a strict, sorted, JSON-safe manifest and HTTP envelopes", () => {
    const parsedManifest = projectBundleManifestV1Schema.parse(manifest());
    const request = projectBundleExportRequestSchema.parse({
      expectedSchemaRevisionNo: 2,
      expectedLayoutRevisionNo: 3,
      reportMode: "REDACTED",
    });
    const response = projectBundleImportResponseSchema.parse({
      bundleSchemaVersion: 1,
      bundleHash: HASH,
      state: projectState(),
      diagnostics: [],
      imported: { revisionCount: 2, layoutCount: 1, reportCount: 0 },
    });

    const clone = Reflect.get(globalThis, "structuredClone") as
      | ((value: unknown) => unknown)
      | undefined;
    expect(clone).toBeTypeOf("function");
    expect(clone?.(JSON.parse(JSON.stringify({ parsedManifest, request, response })))).toEqual({
      parsedManifest,
      request,
      response,
    });
  });

  it("rejects unknown fields, unsorted and duplicate paths, and inconsistent revision evidence", () => {
    expect(
      projectBundleManifestV1Schema.safeParse({ ...manifest(), unexpected: true }).success,
    ).toBe(false);
    const unsorted = manifest();
    const lastEntry = unsorted.entries.at(-1);
    if (lastEntry === undefined) throw new Error("The manifest fixture must contain entries.");
    unsorted.entries = [lastEntry, ...unsorted.entries.slice(0, -1)];
    expect(projectBundleManifestV1Schema.safeParse(unsorted).success).toBe(false);
    const duplicate = manifest();
    const firstEntry = duplicate.entries[0];
    if (firstEntry === undefined) throw new Error("The manifest fixture must contain entries.");
    duplicate.entries = [...duplicate.entries, firstEntry];
    expect(projectBundleManifestV1Schema.safeParse(duplicate).success).toBe(false);
    expect(
      projectBundleManifestV1Schema.safeParse({
        ...manifest(),
        project: { ...manifest().project, currentRevisionNo: 3 },
      }).success,
    ).toBe(false);

    const futureRevision = manifest();
    const revision = futureRevision.entries.find(({ kind }) => kind === "SCHEMA_REVISION");
    if (revision?.kind !== "SCHEMA_REVISION") throw new Error("Missing revision fixture.");
    revision.revisionNo = 3;
    revision.path = "history/0000000003.dbml";
    expect(projectBundleManifestV1Schema.safeParse(futureRevision).success).toBe(false);

    const noncontiguousLayout = manifest();
    const layout = noncontiguousLayout.entries.find(({ kind }) => kind === "DIAGRAM_LAYOUT");
    if (layout?.kind !== "DIAGRAM_LAYOUT") throw new Error("Missing layout fixture.");
    layout.path = "layouts/0001.json";
    expect(projectBundleManifestV1Schema.safeParse(noncontiguousLayout).success).toBe(false);

    expect(
      projectBundleManifestV1Schema.safeParse({
        ...manifest(),
        project: { ...manifest().project, name: "   " },
      }).success,
    ).toBe(false);
  });

  it("validates portable layout and SQL artifact entry payloads without parser objects", () => {
    expect(
      projectBundleLayoutEntryV1Schema.parse({
        viewKey: "GLOBAL",
        positions: { 'table:["public","users"]': { x: 1, y: 2 } },
        collapsedGroupKeys: [],
        hiddenElementKeys: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        detailLevel: "FULL",
        baseSchemaHash: HASH,
        revisionNo: 3,
      }).viewKey,
    ).toBe("GLOBAL");

    const report = {
      reportVersion: 1 as const,
      dialect: "POSTGRESQL" as const,
      sourceFilepath: "/import.sql",
      sourceHash: HASH,
      parserInputHash: HASH,
      parserVersions: { dbmlCore: "9.1.1" as const, dbmlParse: "9.1.1" as const },
      capabilityMatrixVersion: 1 as const,
      schemaSemanticsVersion: 1 as const,
      overallStatus: "EXACT" as const,
      applyEligible: true,
      candidateDbmlHash: OTHER_HASH,
      statements: [],
      diagnostics: [],
      semanticVerification: {
        status: "VERIFIED" as const,
        sourceModelHash: OTHER_HASH,
        candidateSchemaHash: OTHER_HASH,
        changes: [] as const,
      },
    };
    const policy = {
      policyVersion: 1 as const,
      dataStatementNos: [] as number[],
      dataHandling: "NOT_PRESENT" as const,
      applyReadiness: "READY" as const,
    };
    expect(
      projectBundleSqlImportArtifactEntryV1Schema.parse({
        sourceArtifactId: ARTIFACT_ID,
        dialect: "POSTGRESQL",
        originalSql: null,
        originalHash: HASH,
        generatedDbml: "Table users { id bigint [pk] }\n",
        parserVersion: "9.1.1",
        envelope: {
          previewVersion: 1,
          evidence: {
            projectId: PROJECT_ID,
            baseSchemaRevisionNo: 1,
            dialect: "POSTGRESQL",
            sourceHash: HASH,
            candidateDbmlHash: OTHER_HASH,
            report,
          },
          previewHash: HASH,
          previewPolicy: policy,
          appliedPolicy: policy,
          originalSqlRetention: "DISCARD",
        },
        status: "APPLIED",
        createdAt: CREATED_AT,
        appliedAt: CREATED_AT,
      }).sourceArtifactId,
    ).toBe(ARTIFACT_ID);
  });
});

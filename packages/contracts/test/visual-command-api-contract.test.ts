import { describe, expect, it } from "vitest";

import {
  errorResponseSchema,
  visualCommandMutationResponseSchema,
  visualCommandPartialImpactSchema,
  visualCommandRequestSchema,
} from "../src/index.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-08-30T01:02:03.004Z";
const TABLE_KEY = 'table:["public","events"]';
const PARTIAL_COLUMN_KEY = 'partialColumn:["audit_fields","created_at"]';
const PARTIAL_KEY = 'partial:["audit_fields"]';
const cloneStructured = (globalThis as unknown as { structuredClone<T>(value: T): T })
  .structuredClone;

const revision = {
  id: REVISION_ID,
  projectId: PROJECT_ID,
  revisionNo: 2,
  source: "Table events { id int [pk] }",
  sourceHash: "source-hash",
  validity: "VALID",
  origin: "VISUAL_COMMAND",
  parserVersion: "9.1.1",
  diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
  createdAt: CREATED_AT,
};

const state = {
  project: {
    id: PROJECT_ID,
    name: "Schema",
    primaryDialect: "POSTGRESQL",
    draftSource: revision.source,
    draftHash: revision.sourceHash,
    lastValidRevisionId: REVISION_ID,
    parserVersion: "9.1.1",
    schemaRevisionNo: 2,
    layoutRevisionNo: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  currentRevision: revision,
  lastValidRevision: revision,
};

function range(startOffset: number, endOffset: number) {
  return {
    filepath: "/main.dbml",
    startOffset,
    endOffset,
    startLine: 1,
    startColumn: startOffset + 1,
    endLine: 1,
    endColumn: endOffset + 1,
  };
}

function partialImpact() {
  return {
    partialKey: PARTIAL_KEY,
    partialName: "audit_fields",
    partialElementKey: PARTIAL_COLUMN_KEY,
    definitionRange: range(0, 12),
    affectedTables: [
      {
        tableKey: 'table:["public","events"]',
        injectionRange: range(20, 33),
      },
      {
        tableKey: 'table:["public","users"]',
        injectionRange: range(40, 53),
      },
    ],
  };
}

describe("visual command HTTP contracts", () => {
  it("reuses the strict VisualCommand union as the request contract", () => {
    const request = {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 1,
      kind: "CREATE_COLUMN",
      targetTableKey: TABLE_KEY,
      column: {
        name: "created_at",
        type: "timestamp",
        primaryKey: false,
        unique: false,
        notNull: true,
        default: null,
        increment: false,
        note: null,
      },
    };

    expect(visualCommandRequestSchema.parse(request)).toEqual(request);
    expect(visualCommandRequestSchema.safeParse({ ...request, source: "secret" }).success).toBe(
      false,
    );
  });

  it("validates changed, no-op, and replay mutation metadata", () => {
    const response = visualCommandMutationResponseSchema.parse({
      state,
      revisionCreated: true,
      layoutMigrated: false,
      replayed: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 0,
    });

    expect(response.state.project.schemaRevisionNo).toBe(2);
    expect(response.replayed).toBe(true);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(cloneStructured(response)).toEqual(response);
    expect(
      visualCommandMutationResponseSchema.safeParse({ ...response, appliedSchemaRevisionNo: 0 })
        .success,
    ).toBe(false);
    expect(
      visualCommandMutationResponseSchema.safeParse({ ...response, appliedLayoutRevisionNo: -1 })
        .success,
    ).toBe(false);
    expect(
      visualCommandMutationResponseSchema.safeParse({ ...response, source: "secret" }).success,
    ).toBe(false);
  });

  it("validates deterministic partial impact and the shared error envelope", () => {
    const impact = visualCommandPartialImpactSchema.parse(partialImpact());
    const response = errorResponseSchema.parse({
      code: "VISUAL_COMMAND_TRANSFORM_FAILED",
      message: "Visual command could not be applied to the canonical source.",
      correlationId: CORRELATION_ID,
      diagnostics: [
        {
          code: "VISUAL_PARTIAL_TARGET_PROTECTED",
          message: "The target is injected from a TablePartial.",
          severity: "ERROR",
          range: range(0, 12),
        },
      ],
      partialImpact: impact,
    });

    expect(response.partialImpact).toEqual(impact);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(cloneStructured(response)).toEqual(response);
  });

  it("rejects invalid key kinds, unsorted tables, duplicate ranges, and unknown fields", () => {
    const impact = partialImpact();
    expect(
      visualCommandPartialImpactSchema.safeParse({ ...impact, partialKey: TABLE_KEY }).success,
    ).toBe(false);
    expect(
      visualCommandPartialImpactSchema.safeParse({
        ...impact,
        partialElementKey: 'group:["public","audit"]',
      }).success,
    ).toBe(false);
    expect(
      visualCommandPartialImpactSchema.safeParse({
        ...impact,
        affectedTables: impact.affectedTables.toReversed(),
      }).success,
    ).toBe(false);
    expect(
      visualCommandPartialImpactSchema.safeParse({
        ...impact,
        affectedTables: [
          impact.affectedTables[0],
          {
            ...impact.affectedTables[1],
            injectionRange: impact.affectedTables[0]?.injectionRange,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      visualCommandPartialImpactSchema.safeParse({ ...impact, source: "secret" }).success,
    ).toBe(false);
  });

  it("accepts every normalized partial child key kind", () => {
    for (const partialElementKey of [
      'partialColumn:["audit_fields","created_at"]',
      'partialIndex:["audit_fields","audit_created_idx"]',
      'partialCheck:["audit_fields","positive_owner"]',
    ]) {
      expect(
        visualCommandPartialImpactSchema.safeParse({ ...partialImpact(), partialElementKey })
          .success,
      ).toBe(true);
    }
  });
});

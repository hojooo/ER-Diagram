import { DEFAULT_RUNTIME_RESOURCE_LIMITS } from "@er-diagram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  computeSqlImportPreviewHash,
  createProjectBundleApplication,
  parseDbmlV2,
  type DiagramLayout,
  type Project,
  type ProjectBundlePersistencePort,
  type ProjectBundlePersistenceTransaction,
  type ProjectBundleStagedEntries,
  type ProjectBundleStagingSink,
  type SchemaRevision,
  sha256Utf8,
  type SqlImportArtifact,
} from "../../src/index.js";

const SOURCE_PROJECT_ID = "018f0f87-7b5a-7cc0-8000-000000000001";
const REVISION_ID = "018f0f87-7b5a-7cc0-8000-000000000002";
const ARTIFACT_ID = "018f0f87-7b5a-7cc0-8000-000000000003";
const CREATED_AT = "2026-08-31T01:02:03.000Z";
const SOURCE = "Table users {\n  id bigint [pk]\n}\n";
const SQL_SOURCE = "CREATE TABLE users (id bigint PRIMARY KEY);";

class MemoryStaging implements ProjectBundleStagedEntries {
  readonly entries = new Map<string, Uint8Array>();
  readonly sink: ProjectBundleStagingSink;

  constructor() {
    this.sink = {
      writeEntry: async (path: string, content: Uint8Array) => {
        this.entries.set(path, new Uint8Array(content));
      },
    };
  }

  async listPaths(): Promise<readonly string[]> {
    return [...this.entries.keys()].sort();
  }

  async readEntry(path: string): Promise<Uint8Array> {
    return this.readEntrySync(path);
  }

  readEntrySync(path: string): Uint8Array {
    const value = this.entries.get(path);
    if (!value) throw new Error(`Missing staged entry: ${path}`);
    return new Uint8Array(value);
  }
}

class MemoryBundleRepository implements ProjectBundlePersistencePort {
  readonly projects = new Map<string, Project>();
  readonly revisions = new Map<string, SchemaRevision[]>();
  readonly layouts = new Map<string, DiagramLayout[]>();
  readonly artifacts = new Map<string, SqlImportArtifact[]>();

  listProjects(): readonly Project[] {
    return [...this.projects.values()];
  }

  getProject(projectId: string): Project | null {
    return this.projects.get(projectId) ?? null;
  }

  getRevisionById(projectId: string, revisionId: string): SchemaRevision | null {
    return this.listRevisions(projectId).find(({ id }) => id === revisionId) ?? null;
  }

  getRevisionByNumber(projectId: string, revisionNo: number): SchemaRevision | null {
    return (
      this.listRevisions(projectId).find((revision) => revision.revisionNo === revisionNo) ?? null
    );
  }

  listRevisions(projectId: string): readonly SchemaRevision[] {
    return [...(this.revisions.get(projectId) ?? [])].sort((a, b) => b.revisionNo - a.revisionNo);
  }

  listLayouts(projectId: string): readonly DiagramLayout[] {
    return this.layouts.get(projectId) ?? [];
  }

  listImportArtifacts(projectId: string): readonly SqlImportArtifact[] {
    return this.artifacts.get(projectId) ?? [];
  }

  transaction<T>(operation: (transaction: ProjectBundlePersistenceTransaction) => T): T {
    const snapshot = structuredClone({
      projects: [...this.projects],
      revisions: [...this.revisions],
      layouts: [...this.layouts],
      artifacts: [...this.artifacts],
    });
    const transaction: ProjectBundlePersistenceTransaction = {
      listProjects: () => this.listProjects(),
      getProject: (id) => this.getProject(id),
      getRevisionById: (id, revisionId) => this.getRevisionById(id, revisionId),
      getRevisionByNumber: (id, no) => this.getRevisionByNumber(id, no),
      listRevisions: (id) => this.listRevisions(id),
      listLayouts: (id) => this.listLayouts(id),
      listImportArtifacts: (id) => this.listImportArtifacts(id),
      insertProject: (project) => {
        if (this.projects.has(project.id)) throw new Error("duplicate project");
        this.projects.set(project.id, project);
      },
      insertRevision: (revision) => {
        this.revisions.set(revision.projectId, [
          ...(this.revisions.get(revision.projectId) ?? []),
          revision,
        ]);
      },
      insertLayout: (layout) => {
        this.layouts.set(layout.projectId, [...(this.layouts.get(layout.projectId) ?? []), layout]);
      },
      insertImportArtifact: (artifact) => {
        this.artifacts.set(artifact.projectId, [
          ...(this.artifacts.get(artifact.projectId) ?? []),
          artifact,
        ]);
      },
      updateProject: () => false,
      deleteProject: () => false,
      deleteRevisions: () => 0,
    };
    try {
      return operation(transaction);
    } catch (error) {
      this.projects.clear();
      this.revisions.clear();
      this.layouts.clear();
      this.artifacts.clear();
      for (const [key, value] of snapshot.projects) this.projects.set(key, value);
      for (const [key, value] of snapshot.revisions) this.revisions.set(key, value);
      for (const [key, value] of snapshot.layouts) this.layouts.set(key, value);
      for (const [key, value] of snapshot.artifacts) this.artifacts.set(key, value);
      throw error;
    }
  }
}

describe("ProjectBundleApplication", () => {
  let repository: MemoryBundleRepository;
  let generated = 10;

  beforeEach(async () => {
    repository = new MemoryBundleRepository();
    generated = 10;
    const sourceHash = await sha256Utf8(SOURCE);
    const project: Project = {
      id: SOURCE_PROJECT_ID,
      name: "Portable 🚀 schema",
      primaryDialect: "POSTGRESQL",
      draftSource: SOURCE,
      draftHash: sourceHash,
      lastValidRevisionId: REVISION_ID,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 4,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    repository.projects.set(project.id, project);
    repository.revisions.set(project.id, [
      {
        id: REVISION_ID,
        projectId: project.id,
        revisionNo: 1,
        source: SOURCE,
        sourceHash,
        validity: "VALID",
        origin: "SOURCE_EDIT",
        parserVersion: "9.1.1",
        diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
        createdAt: CREATED_AT,
      },
    ]);
    repository.layouts.set(project.id, [
      {
        projectId: project.id,
        viewKey: "GLOBAL",
        positions: { 'table:["public","users"]': { x: 12, y: 34 } },
        collapsedGroupKeys: [],
        hiddenElementKeys: [],
        viewport: { x: 1, y: 2, zoom: 0.75 },
        detailLevel: "FULL",
        baseSchemaHash: sourceHash,
        revisionNo: 4,
      },
    ]);
    repository.artifacts.set(project.id, [await previewArtifact(sourceHash)]);
  });

  it("exports redacted evidence and atomically imports an independent re-keyed project", async () => {
    const app = application(repository, () => nextId());
    const staging = new MemoryStaging();
    const exported = await app.exportBundle({
      projectId: SOURCE_PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      expectedLayoutRevisionNo: 4,
      reportMode: "REDACTED",
      staging: staging.sink,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.manifest.entries.map(({ path }) => path)).toEqual([
      "history/0000000001.dbml",
      "layouts/0000.json",
      "reports/import/0000.json",
      "schema/main.dbml",
    ]);
    const portableArtifact = JSON.parse(
      new TextDecoder().decode(staging.readEntrySync("reports/import/0000.json")),
    );
    expect(portableArtifact).toMatchObject({
      originalSql: null,
      status: "CANCELLED",
      envelope: { originalSqlRetention: "DISCARD" },
    });

    const imported = await app.importBundle({ staging });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.state.project.id).not.toBe(SOURCE_PROJECT_ID);
    expect(imported.value.state.project).toMatchObject({
      name: "Portable 🚀 schema",
      draftSource: SOURCE,
      schemaRevisionNo: 1,
      layoutRevisionNo: 4,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    expect(imported.value.imported).toEqual({ revisionCount: 1, layoutCount: 1, reportCount: 1 });
    const importedId = imported.value.state.project.id;
    expect(repository.layouts.get(importedId)?.[0]).toMatchObject({
      projectId: importedId,
      viewKey: "GLOBAL",
      revisionNo: 4,
    });
    const importedArtifact = repository.artifacts.get(importedId)?.[0];
    expect(importedArtifact).toMatchObject({
      projectId: importedId,
      status: "CANCELLED",
      originalSql: null,
    });
    expect(importedArtifact?.id).not.toBe(ARTIFACT_ID);
    if (importedArtifact && !("operation" in importedArtifact.envelope)) {
      expect(importedArtifact.envelope.evidence.projectId).toBe(importedId);
    }
    expect(repository.projects.get(SOURCE_PROJECT_ID)?.draftSource).toBe(SOURCE);

    const repeated = await app.importBundle({ staging });
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.value.state.project.id).not.toBe(importedId);
    expect(repeated.value.state.project.name).toBe("Portable 🚀 schema");
  });

  it("retains original SQL only when explicitly requested and can omit reports", async () => {
    const app = application(repository, () => nextId());
    const retained = new MemoryStaging();
    const retainedExport = await app.exportBundle({
      projectId: SOURCE_PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      expectedLayoutRevisionNo: 4,
      reportMode: "INCLUDE_RETAINED_SQL",
      staging: retained.sink,
    });
    expect(retainedExport.ok).toBe(true);
    const retainedArtifact = JSON.parse(
      new TextDecoder().decode(retained.readEntrySync("reports/import/0000.json")),
    );
    expect(retainedArtifact).toMatchObject({
      originalSql: SQL_SOURCE,
      status: "CANCELLED",
      envelope: { originalSqlRetention: "RETAIN" },
    });
    const retainedImport = await app.importBundle({ staging: retained });
    expect(retainedImport.ok).toBe(true);
    if (!retainedImport.ok) return;
    expect(repository.artifacts.get(retainedImport.value.state.project.id)?.[0]).toMatchObject({
      originalSql: SQL_SOURCE,
      status: "CANCELLED",
      envelope: { originalSqlRetention: "RETAIN" },
    });

    const omitted = new MemoryStaging();
    const omittedExport = await app.exportBundle({
      projectId: SOURCE_PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      expectedLayoutRevisionNo: 4,
      reportMode: "OMIT",
      staging: omitted.sink,
    });
    expect(omittedExport.ok).toBe(true);
    if (!omittedExport.ok) return;
    expect(
      omittedExport.value.manifest.entries.some(({ kind }) => kind === "SQL_IMPORT_ARTIFACT"),
    ).toBe(false);
    expect(await omitted.listPaths()).not.toContain("reports/import/0000.json");
  });

  it("rejects tampered entry bytes before creating a project", async () => {
    const app = application(repository, () => nextId());
    const staging = new MemoryStaging();
    const exported = await app.exportBundle({
      projectId: SOURCE_PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      expectedLayoutRevisionNo: 4,
      staging: staging.sink,
    });
    expect(exported.ok).toBe(true);
    staging.entries.set("schema/main.dbml", new TextEncoder().encode(`${SOURCE}\n`));
    const countBefore = repository.projects.size;
    const imported = await app.importBundle({ staging });
    expect(imported).toMatchObject({ ok: false, error: { code: "PROJECT_BUNDLE_INVALID" } });
    expect(repository.projects.size).toBe(countBefore);
  });

  function nextId(): string {
    return `018f0f87-7b5a-7cc0-8000-${String(generated++).padStart(12, "0")}`;
  }
});

function application(repository: MemoryBundleRepository, generateId: () => string) {
  return createProjectBundleApplication({
    persistence: repository,
    parseSource: parseDbmlV2,
    resourceLimits: DEFAULT_RUNTIME_RESOURCE_LIMITS,
    generateId,
    now: () => CREATED_AT,
  });
}

async function previewArtifact(generatedDbmlHash: string): Promise<SqlImportArtifact> {
  const originalHash = await sha256Utf8(SQL_SOURCE);
  const report = {
    reportVersion: 1 as const,
    dialect: "POSTGRESQL" as const,
    sourceFilepath: "/import.sql",
    sourceHash: originalHash,
    parserInputHash: originalHash,
    parserVersions: { dbmlCore: "9.1.1" as const, dbmlParse: "9.1.1" as const },
    capabilityMatrixVersion: 1 as const,
    schemaSemanticsVersion: 1 as const,
    overallStatus: "EXACT" as const,
    applyEligible: true,
    candidateDbmlHash: generatedDbmlHash,
    statements: [],
    diagnostics: [],
    semanticVerification: {
      status: "VERIFIED" as const,
      sourceModelHash: generatedDbmlHash,
      candidateSchemaHash: generatedDbmlHash,
      changes: [] as [],
    },
  };
  const policy = {
    policyVersion: 1 as const,
    dataStatementNos: [] as number[],
    dataHandling: "NOT_PRESENT" as const,
    applyReadiness: "READY" as const,
  };
  const evidence = {
    projectId: SOURCE_PROJECT_ID,
    baseSchemaRevisionNo: 1,
    dialect: "POSTGRESQL" as const,
    sourceHash: originalHash,
    candidateDbmlHash: generatedDbmlHash,
    report,
  };
  return {
    id: ARTIFACT_ID,
    projectId: SOURCE_PROJECT_ID,
    dialect: "POSTGRESQL",
    originalSql: SQL_SOURCE,
    originalHash,
    generatedDbml: SOURCE,
    parserVersion: "9.1.1",
    envelope: {
      previewVersion: 1,
      evidence,
      previewHash: await computeSqlImportPreviewHash({
        evidence,
        previewPolicy: policy,
        originalSqlRetention: "RETAIN",
      }),
      previewPolicy: policy,
      appliedPolicy: null,
      originalSqlRetention: "RETAIN",
    },
    status: "PREVIEWED",
    createdAt: CREATED_AT,
    appliedAt: null,
  };
}

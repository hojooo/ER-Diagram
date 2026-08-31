import {
  PROJECT_BUNDLE_SCHEMA_VERSION,
  projectBundleLayoutEntryV1Schema,
  projectBundleManifestV1Schema,
  projectBundleSqlImportArtifactEntryV1Schema,
  type ProjectBundleEntryDescriptor,
  type ProjectBundleImportArtifactEntryDescriptor,
  type ProjectBundleLayoutEntryV1,
  type ProjectBundleManifestV1,
  type ProjectBundleReportMode,
  type ProjectBundleRevisionEntryDescriptor,
  utf8ByteLength,
} from "@er-diagram/contracts";

import { sha256Utf8 } from "../hash.js";
import { DBML_PARSER_VERSION } from "../schema-graph.js";
import { canonicalStringify, compareCodeUnits } from "../schema-semantics.js";
import type { DiagramLayout } from "./layout.js";
import type { Project, SchemaRevision } from "./project.js";
import {
  type CreateProjectBundleApplicationOptions,
  type ExportProjectBundleCommand,
  type ImportProjectBundleCommand,
  type ProjectBundleApplication,
  type ProjectBundleApplicationError,
  type ProjectBundleApplicationResult,
  type ProjectBundleExportMutation,
  type ProjectBundleImportMutation,
  ProjectBundlePersistenceInvariantError,
} from "./project-bundle.js";
import { ProjectStateReadError, readProjectState, summarizeDiagnostics } from "./project-state.js";
import type {
  SqlImportArtifact,
  SqlImportArtifactEnvelope,
  SqlImportCreateArtifactEnvelope,
  SqlImportReplaceArtifactEnvelope,
} from "./sql-import.js";
import { isCreateProjectSqlImportEnvelope } from "./sql-import.js";
import {
  computeSqlImportCreatePreviewHash,
  computeSqlImportPreviewHash,
} from "./sql-import-application.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MANIFEST_PATH = "manifest.json";
const CURRENT_DBML_PATH = "schema/main.dbml";

interface PortableRevision {
  readonly descriptor: ProjectBundleRevisionEntryDescriptor;
}

interface PortableLayout {
  readonly descriptor: Extract<ProjectBundleEntryDescriptor, { kind: "DIAGRAM_LAYOUT" }>;
  readonly value: ProjectBundleLayoutEntryV1;
}

interface PortableArtifact {
  readonly descriptor: ProjectBundleImportArtifactEntryDescriptor;
  readonly value: ReturnType<typeof projectBundleSqlImportArtifactEntryV1Schema.parse>;
}

class ExpectedBundleFailure extends Error {
  constructor(readonly applicationError: ProjectBundleApplicationError) {
    super(applicationError.message);
    this.name = "ExpectedBundleFailure";
  }
}

export function createProjectBundleApplication(
  options: CreateProjectBundleApplicationOptions,
): ProjectBundleApplication {
  return {
    exportBundle: (command) => exportProjectBundle(options, command),
    importBundle: (command) => importProjectBundle(options, command),
  };
}

export function projectBundleHashPreimage(
  manifest: Omit<ProjectBundleManifestV1, "bundleHash"> | ProjectBundleManifestV1,
): string {
  const { bundleHash: _bundleHash, ...withoutHash } = manifest as ProjectBundleManifestV1;
  return canonicalStringify(withoutHash);
}

export async function computeProjectBundleHash(
  manifest: Omit<ProjectBundleManifestV1, "bundleHash"> | ProjectBundleManifestV1,
): Promise<string> {
  return sha256Utf8(projectBundleHashPreimage(manifest));
}

export function canonicalProjectBundleJson(value: unknown): string {
  return `${canonicalStringify(value)}\n`;
}

async function exportProjectBundle(
  options: CreateProjectBundleApplicationOptions,
  command: ExportProjectBundleCommand,
): Promise<ProjectBundleApplicationResult<ProjectBundleExportMutation>> {
  try {
    const state = readProjectState(options.persistence, command.projectId);
    expectExportRevisions(state.project, command);
    const revisions = options.persistence.listRevisions(command.projectId);
    const layouts = options.persistence.listLayouts(command.projectId);
    const artifacts = options.persistence.listImportArtifacts(command.projectId);
    const snapshotToken = await computeSnapshotToken(state.project, revisions, layouts, artifacts);
    const reportMode = command.reportMode ?? "REDACTED";
    const descriptors: ProjectBundleEntryDescriptor[] = [];
    let expandedBytes = 0;

    const stage = async (
      path: string,
      content: Uint8Array,
    ): Promise<{ bytes: number; sha256: string }> => {
      assertEntryBudget(options, content.byteLength);
      expandedBytes = addExpandedBytes(options, expandedBytes, content.byteLength);
      await command.staging.writeEntry(path, content);
      return { bytes: content.byteLength, sha256: await sha256Bytes(content) };
    };

    for (const revision of [...revisions].sort(compareRevisionsAscending)) {
      const sourceHash = await sha256Utf8(revision.source);
      if (sourceHash !== revision.sourceHash) {
        throw storageInvariant(command.projectId, "Stored revision source hash is invalid.");
      }
      const path = revisionPath(revision.revisionNo);
      const evidence = await stage(path, encoder.encode(revision.source));
      descriptors.push({
        kind: "SCHEMA_REVISION",
        path,
        ...evidence,
        revisionNo: revision.revisionNo,
        validity: revision.validity,
        origin: revision.origin,
        parserVersion: revision.parserVersion,
        diagnosticSummary: { ...revision.diagnosticSummary },
        createdAt: revision.createdAt,
      });
    }

    const sortedLayouts = [...layouts].sort((left, right) =>
      compareCodeUnits(left.viewKey, right.viewKey),
    );
    for (const [index, layout] of sortedLayouts.entries()) {
      const value = portableLayout(layout);
      const path = layoutPath(index);
      const evidence = await stage(path, encoder.encode(canonicalProjectBundleJson(value)));
      descriptors.push({
        kind: "DIAGRAM_LAYOUT",
        path,
        ...evidence,
        viewKey: layout.viewKey,
        revisionNo: layout.revisionNo,
      });
    }

    const portableArtifacts =
      reportMode === "OMIT"
        ? []
        : await Promise.all(
            [...artifacts]
              .sort(compareArtifacts)
              .map((artifact) => makePortableArtifact(artifact, reportMode)),
          );
    for (const [index, artifact] of portableArtifacts.entries()) {
      const path = reportPath(index);
      const evidence = await stage(path, encoder.encode(canonicalProjectBundleJson(artifact)));
      descriptors.push({
        kind: "SQL_IMPORT_ARTIFACT",
        path,
        ...evidence,
        status: artifact.status,
        originalSqlRetention: artifact.envelope.originalSqlRetention,
        createdAt: artifact.createdAt,
        appliedAt: artifact.appliedAt,
      });
    }

    const currentEvidence = await stage(
      CURRENT_DBML_PATH,
      encoder.encode(state.project.draftSource),
    );
    descriptors.push({ kind: "CURRENT_DBML", path: CURRENT_DBML_PATH, ...currentEvidence });
    descriptors.sort((left, right) => compareCodeUnits(left.path, right.path));

    const manifestWithoutHash = {
      format: "ER_DIAGRAM_PROJECT_BUNDLE" as const,
      bundleSchemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      createdAt: options.now(),
      producer: { parserVersion: DBML_PARSER_VERSION },
      sourceProjectId: state.project.id,
      project: {
        name: state.project.name,
        primaryDialect: state.project.primaryDialect,
        parserVersion: state.project.parserVersion,
        schemaRevisionNo: state.project.schemaRevisionNo,
        layoutRevisionNo: state.project.layoutRevisionNo,
        currentRevisionNo: state.currentRevision.revisionNo,
        lastValidRevisionNo: state.lastValidRevision?.revisionNo ?? null,
        createdAt: state.project.createdAt,
        updatedAt: state.project.updatedAt,
      },
      reportMode,
      entries: descriptors,
    };
    const manifest = projectBundleManifestV1Schema.parse({
      ...manifestWithoutHash,
      bundleHash: await computeProjectBundleHash(manifestWithoutHash),
    });
    const manifestContent = encoder.encode(canonicalProjectBundleJson(manifest));
    assertEntryBudget(options, manifestContent.byteLength);
    expandedBytes = addExpandedBytes(options, expandedBytes, manifestContent.byteLength);
    assertEntryCount(options, descriptors.length + 1);
    await command.staging.writeEntry(MANIFEST_PATH, manifestContent);

    const afterState = readProjectState(options.persistence, command.projectId);
    expectExportRevisions(afterState.project, command);
    const afterToken = await computeSnapshotToken(
      afterState.project,
      options.persistence.listRevisions(command.projectId),
      options.persistence.listLayouts(command.projectId),
      options.persistence.listImportArtifacts(command.projectId),
    );
    if (afterToken !== snapshotToken) {
      throw expected({
        code: "PROJECT_BUNDLE_SNAPSHOT_CONFLICT",
        message: "The project changed while its portable bundle was being prepared.",
        projectId: command.projectId,
      });
    }

    return success({
      manifest,
      bundleHash: manifest.bundleHash,
      entryCount: descriptors.length + 1,
      expandedBytes,
    });
  } catch (error) {
    return bundleFailure(error);
  }
}

async function importProjectBundle(
  options: CreateProjectBundleApplicationOptions,
  command: ImportProjectBundleCommand,
): Promise<ProjectBundleApplicationResult<ProjectBundleImportMutation>> {
  try {
    const archivePaths = [...(await command.staging.listPaths())];
    assertEntryCount(options, archivePaths.length);
    assertUniqueSortedPaths(archivePaths);
    if (!archivePaths.includes(MANIFEST_PATH)) throw invalid("The bundle manifest is missing.");

    const manifestBytes = await command.staging.readEntry(MANIFEST_PATH);
    assertEntryBudget(options, manifestBytes.byteLength);
    let expandedBytes = manifestBytes.byteLength;
    const manifest = parseManifest(manifestBytes);
    const expectedPaths = [MANIFEST_PATH, ...manifest.entries.map(({ path }) => path)].sort(
      compareCodeUnits,
    );
    if (canonicalStringify(archivePaths) !== canonicalStringify(expectedPaths)) {
      throw invalid("The bundle archive entries do not match the manifest allowlist.");
    }
    if ((await computeProjectBundleHash(manifest)) !== manifest.bundleHash) {
      throw invalid("The bundle root hash does not match its manifest evidence.");
    }
    if (
      manifest.producer.parserVersion !== DBML_PARSER_VERSION ||
      manifest.project.parserVersion !== DBML_PARSER_VERSION
    ) {
      throw expected({
        code: "PROJECT_BUNDLE_PARSER_INCOMPATIBLE",
        message: "The bundle parser version is not compatible with this server.",
      });
    }

    const revisions: PortableRevision[] = [];
    const layouts: PortableLayout[] = [];
    const artifacts: PortableArtifact[] = [];
    let currentEntrySource: string | undefined;
    let currentRevisionSource: string | undefined;
    let lastValidSource: string | undefined;
    for (const descriptor of manifest.entries) {
      const bytes = await command.staging.readEntry(descriptor.path);
      assertEntryBudget(options, bytes.byteLength);
      expandedBytes = addExpandedBytes(options, expandedBytes, bytes.byteLength);
      if (
        bytes.byteLength !== descriptor.bytes ||
        (await sha256Bytes(bytes)) !== descriptor.sha256
      ) {
        throw invalid("A bundle entry does not match its byte and hash evidence.");
      }
      if (descriptor.kind === "CURRENT_DBML") {
        currentEntrySource = decodeUtf8(bytes);
      } else if (descriptor.kind === "SCHEMA_REVISION") {
        const source = decodeUtf8(bytes);
        if ((await sha256Utf8(source)) !== descriptor.sha256) {
          throw invalid("A retained schema revision has invalid source hash evidence.");
        }
        revisions.push({ descriptor });
        if (descriptor.revisionNo === manifest.project.currentRevisionNo) {
          currentRevisionSource = source;
        }
        if (descriptor.revisionNo === manifest.project.lastValidRevisionNo)
          lastValidSource = source;
      } else if (descriptor.kind === "DIAGRAM_LAYOUT") {
        const value = projectBundleLayoutEntryV1Schema.parse(parseJson(bytes));
        if (value.viewKey !== descriptor.viewKey || value.revisionNo !== descriptor.revisionNo) {
          throw invalid("A portable layout does not match its descriptor evidence.");
        }
        if (value.revisionNo > manifest.project.layoutRevisionNo) {
          throw invalid("A portable layout revision exceeds the project layout revision.");
        }
        layouts.push({ descriptor, value });
      } else {
        const value = projectBundleSqlImportArtifactEntryV1Schema.parse(parseJson(bytes));
        if (
          value.status !== descriptor.status ||
          value.envelope.originalSqlRetention !== descriptor.originalSqlRetention ||
          value.createdAt !== descriptor.createdAt ||
          value.appliedAt !== descriptor.appliedAt
        ) {
          throw invalid("A portable SQL import report does not match its descriptor evidence.");
        }
        await validatePortableArtifact(value, manifest);
        artifacts.push({ descriptor, value });
      }
    }

    if (currentEntrySource === undefined || currentRevisionSource === undefined) {
      throw invalid("The bundle current DBML is missing.");
    }
    if (currentEntrySource !== currentRevisionSource) {
      throw invalid("The current DBML does not match the current retained revision.");
    }
    const currentSource = currentEntrySource;
    if (utf8ByteLength(currentSource) > options.resourceLimits.maxSourceBytes) {
      throw resourceLimit("SOURCE", "The bundle current DBML exceeds the source byte limit.");
    }
    const currentDescriptor = revisions.find(
      ({ descriptor }) => descriptor.revisionNo === manifest.project.currentRevisionNo,
    )?.descriptor;
    if (!currentDescriptor || currentDescriptor.sha256 !== (await sha256Utf8(currentSource))) {
      throw invalid("The current revision evidence is incomplete.");
    }
    if (currentDescriptor.parserVersion !== DBML_PARSER_VERSION) {
      throw parserIncompatible("The current revision parser version is not compatible.");
    }

    const currentParse = await options.parseSource(currentSource, "/main.dbml");
    const currentDiagnostics = currentParse.ok
      ? currentParse.graph.diagnostics
      : currentParse.diagnostics;
    const currentValidity = currentParse.ok ? "VALID" : "INVALID";
    if (
      currentParse.sourceHash !== currentDescriptor.sha256 ||
      currentValidity !== currentDescriptor.validity ||
      canonicalStringify(summarizeDiagnostics(currentDiagnostics)) !==
        canonicalStringify(currentDescriptor.diagnosticSummary)
    ) {
      throw invalid("The current DBML no longer matches its validation evidence.");
    }

    if (manifest.project.lastValidRevisionNo !== null) {
      if (lastValidSource === undefined) throw invalid("The last-valid source is missing.");
      const lastValidDescriptor = revisions.find(
        ({ descriptor }) => descriptor.revisionNo === manifest.project.lastValidRevisionNo,
      )?.descriptor;
      if (lastValidDescriptor?.validity !== "VALID") {
        throw invalid("The last-valid pointer does not reference a valid revision.");
      }
      if (lastValidDescriptor.parserVersion !== DBML_PARSER_VERSION) {
        throw parserIncompatible("The last-valid revision parser version is not compatible.");
      }
      if (utf8ByteLength(lastValidSource) > options.resourceLimits.maxSourceBytes) {
        throw resourceLimit("SOURCE", "The bundle last-valid DBML exceeds the source byte limit.");
      }
      const lastValidParse = await options.parseSource(lastValidSource, "/main.dbml");
      if (!lastValidParse.ok) throw invalid("The retained last-valid DBML is not valid.");
      if (
        lastValidParse.sourceHash !== lastValidDescriptor.sha256 ||
        canonicalStringify(summarizeDiagnostics(lastValidParse.graph.diagnostics)) !==
          canonicalStringify(lastValidDescriptor.diagnosticSummary)
      ) {
        throw invalid("The last-valid DBML no longer matches its validation evidence.");
      }
    } else if (currentParse.ok) {
      throw invalid("A valid current revision must also be the last-valid revision.");
    }

    const projectId = options.generateId();
    const revisionIds = new Map<number, string>();
    for (const revision of revisions)
      revisionIds.set(revision.descriptor.revisionNo, options.generateId());
    const importedArtifacts = await Promise.all(
      artifacts.map(({ value }) => rekeyPortableArtifact(value, projectId, options.generateId())),
    );

    const result = options.persistence.transaction((transaction) => {
      const portableRevisions = revisions
        .map(({ descriptor }) => toImportedRevision(command, descriptor, projectId, revisionIds))
        .sort(compareRevisionsAscending);
      const currentRevision = portableRevisions.find(
        ({ revisionNo }) => revisionNo === manifest.project.currentRevisionNo,
      );
      if (!currentRevision) throw invalid("The current revision could not be reconstructed.");
      const lastValidRevisionId =
        manifest.project.lastValidRevisionNo === null
          ? null
          : (revisionIds.get(manifest.project.lastValidRevisionNo) ?? null);
      if (manifest.project.lastValidRevisionNo !== null && lastValidRevisionId === null) {
        throw invalid("The last-valid revision could not be reconstructed.");
      }

      const project: Project = {
        id: projectId,
        name: manifest.project.name,
        primaryDialect: manifest.project.primaryDialect,
        draftSource: currentRevision.source,
        draftHash: currentRevision.sourceHash,
        lastValidRevisionId,
        parserVersion: manifest.project.parserVersion,
        schemaRevisionNo: manifest.project.schemaRevisionNo,
        layoutRevisionNo: manifest.project.layoutRevisionNo,
        createdAt: manifest.project.createdAt,
        updatedAt: manifest.project.updatedAt,
      };
      transaction.insertProject(project);
      for (const revision of portableRevisions) transaction.insertRevision(revision);
      for (const { value } of layouts) transaction.insertLayout(toImportedLayout(value, projectId));
      for (const artifact of importedArtifacts) transaction.insertImportArtifact(artifact);
      return readProjectState(transaction, projectId);
    });

    return success({
      bundleSchemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      bundleHash: manifest.bundleHash,
      state: result,
      diagnostics: currentDiagnostics,
      imported: {
        revisionCount: revisions.length,
        layoutCount: layouts.length,
        reportCount: artifacts.length,
      },
    });
  } catch (error) {
    return bundleFailure(error);
  }
}

function expectExportRevisions(project: Project, command: ExportProjectBundleCommand): void {
  if (project.schemaRevisionNo !== command.expectedSchemaRevisionNo) {
    throw expected({
      code: "PROJECT_BUNDLE_SCHEMA_REVISION_CONFLICT",
      message: "The project schema revision changed before bundle export.",
      projectId: project.id,
      expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
      currentSchemaRevisionNo: project.schemaRevisionNo,
    });
  }
  if (project.layoutRevisionNo !== command.expectedLayoutRevisionNo) {
    throw expected({
      code: "PROJECT_BUNDLE_LAYOUT_REVISION_CONFLICT",
      message: "The project layout revision changed before bundle export.",
      projectId: project.id,
      expectedLayoutRevisionNo: command.expectedLayoutRevisionNo,
      currentLayoutRevisionNo: project.layoutRevisionNo,
    });
  }
}

async function computeSnapshotToken(
  project: Project,
  revisions: readonly SchemaRevision[],
  layouts: readonly DiagramLayout[],
  artifacts: readonly SqlImportArtifact[],
): Promise<string> {
  return sha256Utf8(
    canonicalStringify({
      project,
      revisions: revisions.map(({ source: _source, ...revision }) => revision),
      layouts,
      artifacts: artifacts.map(
        ({ originalSql: _sql, generatedDbml: _dbml, ...artifact }) => artifact,
      ),
    }),
  );
}

function portableLayout(layout: DiagramLayout): ProjectBundleLayoutEntryV1 {
  return projectBundleLayoutEntryV1Schema.parse({
    viewKey: layout.viewKey,
    positions: layout.positions,
    collapsedGroupKeys: [...layout.collapsedGroupKeys],
    hiddenElementKeys: [...layout.hiddenElementKeys],
    viewport: layout.viewport,
    detailLevel: layout.detailLevel,
    baseSchemaHash: layout.baseSchemaHash,
    revisionNo: layout.revisionNo,
  });
}

async function makePortableArtifact(
  artifact: SqlImportArtifact,
  reportMode: Exclude<ProjectBundleReportMode, "OMIT">,
): Promise<ReturnType<typeof projectBundleSqlImportArtifactEntryV1Schema.parse>> {
  const retention = reportMode === "REDACTED" ? "DISCARD" : artifact.envelope.originalSqlRetention;
  const envelope = await withArtifactRetention(artifact.envelope, retention);
  return projectBundleSqlImportArtifactEntryV1Schema.parse({
    sourceArtifactId: artifact.id,
    dialect: artifact.dialect,
    originalSql: retention === "RETAIN" ? artifact.originalSql : null,
    originalHash: artifact.originalHash,
    generatedDbml: artifact.generatedDbml,
    parserVersion: artifact.parserVersion,
    envelope,
    status: artifact.status === "PREVIEWED" ? "CANCELLED" : artifact.status,
    createdAt: artifact.createdAt,
    appliedAt: artifact.status === "PREVIEWED" ? null : artifact.appliedAt,
  });
}

async function withArtifactRetention(
  envelope: SqlImportArtifactEnvelope,
  originalSqlRetention: "DISCARD" | "RETAIN",
): Promise<SqlImportArtifactEnvelope> {
  if (isCreateProjectSqlImportEnvelope(envelope)) {
    const updated: SqlImportCreateArtifactEnvelope = { ...envelope, originalSqlRetention };
    return {
      ...updated,
      previewHash: await computeSqlImportCreatePreviewHash({
        evidence: updated.evidence,
        previewPolicy: updated.previewPolicy,
        originalSqlRetention,
      }),
    };
  }
  const updated: SqlImportReplaceArtifactEnvelope = { ...envelope, originalSqlRetention };
  return {
    ...updated,
    previewHash: await computeSqlImportPreviewHash({
      evidence: updated.evidence,
      previewPolicy: updated.previewPolicy,
      originalSqlRetention,
    }),
  };
}

async function validatePortableArtifact(
  artifact: ReturnType<typeof projectBundleSqlImportArtifactEntryV1Schema.parse>,
  manifest: ProjectBundleManifestV1,
): Promise<void> {
  if (artifact.status === "PREVIEWED") throw invalid("Portable previews must be cancelled.");
  if (manifest.reportMode === "OMIT") throw invalid("An omitted report bundle contains a report.");
  if (
    manifest.reportMode === "REDACTED" &&
    (artifact.originalSql !== null || artifact.envelope.originalSqlRetention !== "DISCARD")
  ) {
    throw invalid("A redacted bundle retains original SQL.");
  }
  if (artifact.envelope.originalSqlRetention === "RETAIN") {
    if (
      artifact.originalSql === null ||
      (await sha256Utf8(artifact.originalSql)) !== artifact.originalHash
    ) {
      throw invalid("A retained SQL artifact does not match its source hash.");
    }
  } else if (artifact.originalSql !== null) {
    throw invalid("A discarded SQL artifact contains original SQL.");
  }
  const report = artifact.envelope.evidence.report;
  if (
    artifact.envelope.evidence.dialect !== artifact.dialect ||
    artifact.envelope.evidence.sourceHash !== artifact.originalHash ||
    report.sourceHash !== artifact.originalHash ||
    report.parserInputHash !== artifact.originalHash ||
    report.dialect !== artifact.dialect ||
    report.parserVersions.dbmlParse !== artifact.parserVersion ||
    report.candidateDbmlHash !== artifact.envelope.evidence.candidateDbmlHash
  ) {
    throw invalid("A SQL artifact does not match its conversion evidence.");
  }
  if (isCreateProjectSqlImportEnvelope(artifact.envelope) && artifact.status !== "APPLIED") {
    throw invalid("A created-project SQL artifact must already be applied.");
  }
  if (artifact.status === "FAILED") {
    if (
      artifact.generatedDbml !== null ||
      artifact.envelope.evidence.candidateDbmlHash !== null ||
      artifact.envelope.appliedPolicy !== null ||
      artifact.appliedAt !== null
    ) {
      throw invalid("A failed SQL artifact contains successful preview evidence.");
    }
  } else if (
    artifact.generatedDbml === null ||
    artifact.envelope.evidence.candidateDbmlHash === null ||
    (await sha256Utf8(artifact.generatedDbml)) !== artifact.envelope.evidence.candidateDbmlHash
  ) {
    throw invalid("A SQL artifact candidate does not match its conversion evidence.");
  }
  if (artifact.status === "APPLIED") {
    if (artifact.appliedAt === null || artifact.envelope.appliedPolicy === null) {
      throw invalid("An applied SQL artifact is missing its applied evidence.");
    }
  } else if (artifact.appliedAt !== null || artifact.envelope.appliedPolicy !== null) {
    throw invalid("An unapplied SQL artifact contains applied evidence.");
  }
  const expected = await withArtifactRetention(
    artifact.envelope,
    artifact.envelope.originalSqlRetention,
  );
  if (expected.previewHash !== artifact.envelope.previewHash) {
    throw invalid("A SQL artifact preview hash does not match its evidence.");
  }
  if (!isCreateProjectSqlImportEnvelope(artifact.envelope)) {
    if (artifact.envelope.evidence.projectId !== manifest.sourceProjectId) {
      throw invalid("A SQL artifact project evidence does not match the source project.");
    }
  }
  if (
    artifact.envelope.evidence.sourceHash !== artifact.originalHash ||
    artifact.envelope.evidence.report.sourceHash !== artifact.originalHash
  ) {
    throw invalid("A SQL artifact source evidence is inconsistent.");
  }
}

async function rekeyPortableArtifact(
  portable: ReturnType<typeof projectBundleSqlImportArtifactEntryV1Schema.parse>,
  projectId: string,
  artifactId: string,
): Promise<SqlImportArtifact> {
  let envelope: SqlImportArtifactEnvelope;
  if (isCreateProjectSqlImportEnvelope(portable.envelope)) {
    envelope = await withArtifactRetention(
      portable.envelope,
      portable.envelope.originalSqlRetention,
    );
  } else {
    const updated: SqlImportReplaceArtifactEnvelope = {
      ...portable.envelope,
      evidence: { ...portable.envelope.evidence, projectId },
    };
    envelope = {
      ...updated,
      previewHash: await computeSqlImportPreviewHash({
        evidence: updated.evidence,
        previewPolicy: updated.previewPolicy,
        originalSqlRetention: updated.originalSqlRetention,
      }),
    };
  }
  return {
    id: artifactId,
    projectId,
    dialect: portable.dialect,
    originalSql: portable.originalSql,
    originalHash: portable.originalHash,
    generatedDbml: portable.generatedDbml,
    parserVersion: portable.parserVersion,
    envelope,
    status: portable.status,
    createdAt: portable.createdAt,
    appliedAt: portable.appliedAt,
  };
}

function toImportedRevision(
  command: ImportProjectBundleCommand,
  descriptor: ProjectBundleRevisionEntryDescriptor,
  projectId: string,
  ids: ReadonlyMap<number, string>,
): SchemaRevision {
  const source = decodeUtf8(command.staging.readEntrySync(descriptor.path));
  const id = ids.get(descriptor.revisionNo);
  if (id === undefined) throw invalid("A retained revision ID could not be reconstructed.");
  return {
    id,
    projectId,
    revisionNo: descriptor.revisionNo,
    source,
    sourceHash: descriptor.sha256,
    validity: descriptor.validity,
    origin: descriptor.origin,
    parserVersion: descriptor.parserVersion,
    diagnosticSummary: descriptor.diagnosticSummary,
    createdAt: descriptor.createdAt,
  };
}

function toImportedLayout(value: ProjectBundleLayoutEntryV1, projectId: string): DiagramLayout {
  return {
    projectId,
    viewKey: value.viewKey,
    positions: value.positions,
    collapsedGroupKeys: value.collapsedGroupKeys,
    hiddenElementKeys: value.hiddenElementKeys,
    viewport: value.viewport,
    detailLevel: value.detailLevel,
    baseSchemaHash: value.baseSchemaHash,
    revisionNo: value.revisionNo,
  };
}

function parseManifest(bytes: Uint8Array): ProjectBundleManifestV1 {
  try {
    return projectBundleManifestV1Schema.parse(JSON.parse(decodeUtf8(bytes)));
  } catch {
    throw invalid("The bundle manifest is malformed.");
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch {
    throw invalid("A bundle JSON entry is malformed.");
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw invalid("A bundle text entry is not valid UTF-8.");
  }
}

function revisionPath(revisionNo: number): string {
  return `history/${String(revisionNo).padStart(10, "0")}.dbml`;
}

function layoutPath(index: number): string {
  return `layouts/${String(index).padStart(4, "0")}.json`;
}

function reportPath(index: number): string {
  return `reports/import/${String(index).padStart(4, "0")}.json`;
}

function compareRevisionsAscending(left: SchemaRevision, right: SchemaRevision): number {
  return left.revisionNo - right.revisionNo || compareCodeUnits(left.id, right.id);
}

function compareArtifacts(left: SqlImportArtifact, right: SqlImportArtifact): number {
  return compareCodeUnits(left.createdAt, right.createdAt) || compareCodeUnits(left.id, right.id);
}

function assertUniqueSortedPaths(paths: string[]): void {
  const sorted = [...paths].sort(compareCodeUnits);
  if (
    new Set(paths).size !== paths.length ||
    canonicalStringify(paths) !== canonicalStringify(sorted)
  ) {
    throw invalid("The staged bundle paths must be unique and sorted.");
  }
}

function assertEntryBudget(options: CreateProjectBundleApplicationOptions, bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > options.resourceLimits.bundle.maxEntryBytes
  ) {
    throw resourceLimit("ENTRY", "A bundle entry exceeds the configured byte limit.");
  }
}

function assertEntryCount(options: CreateProjectBundleApplicationOptions, count: number): void {
  if (count > options.resourceLimits.bundle.maxEntries) {
    throw resourceLimit("ENTRIES", "The bundle exceeds the configured entry count limit.");
  }
}

function addExpandedBytes(
  options: CreateProjectBundleApplicationOptions,
  current: number,
  additional: number,
): number {
  if (additional > options.resourceLimits.bundle.maxExpandedBytes - current) {
    throw resourceLimit("EXPANDED", "The bundle exceeds the configured expanded byte limit.");
  }
  return current + additional;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function success<T>(value: T): ProjectBundleApplicationResult<T> {
  return { ok: true, value };
}

function invalid(message: string): ExpectedBundleFailure {
  return expected({ code: "PROJECT_BUNDLE_INVALID", message });
}

function resourceLimit(
  limit: Extract<
    ProjectBundleApplicationError,
    { code: "PROJECT_BUNDLE_RESOURCE_LIMIT_EXCEEDED" }
  >["limit"],
  message: string,
): ExpectedBundleFailure {
  return expected({ code: "PROJECT_BUNDLE_RESOURCE_LIMIT_EXCEEDED", message, limit });
}

function parserIncompatible(message: string): ExpectedBundleFailure {
  return expected({ code: "PROJECT_BUNDLE_PARSER_INCOMPATIBLE", message });
}

function storageInvariant(projectId: string | undefined, message: string): ExpectedBundleFailure {
  return expected({
    code: "PROJECT_BUNDLE_STORAGE_INVARIANT_VIOLATION",
    message,
    ...(projectId === undefined ? {} : { projectId }),
  });
}

function expected(error: ProjectBundleApplicationError): ExpectedBundleFailure {
  return new ExpectedBundleFailure(error);
}

function bundleFailure<T>(error: unknown): ProjectBundleApplicationResult<T> {
  if (error instanceof ExpectedBundleFailure) return { ok: false, error: error.applicationError };
  if (error instanceof ProjectStateReadError) {
    if (error.reason === "NOT_FOUND") {
      return {
        ok: false,
        error: {
          code: "PROJECT_BUNDLE_PROJECT_NOT_FOUND",
          message: "Project was not found.",
          projectId: error.projectId,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "PROJECT_BUNDLE_STORAGE_INVARIANT_VIOLATION",
        message: "Stored project state is invalid.",
        projectId: error.projectId,
      },
    };
  }
  if (error instanceof ProjectBundlePersistenceInvariantError) {
    return {
      ok: false,
      error: {
        code: "PROJECT_BUNDLE_STORAGE_INVARIANT_VIOLATION",
        message: "Portable bundle storage could not be completed.",
        ...(error.projectId === undefined ? {} : { projectId: error.projectId }),
      },
    };
  }
  throw error;
}

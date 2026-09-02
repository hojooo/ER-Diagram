#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  P0_RELEASE_EVIDENCE_PROFILE_HASH,
  p0ReleaseEvidenceProfile,
} from "../packages/test-fixtures/dist/index.js";
import {
  assertInventory,
  assertOwnedResourceName,
  assertRedactedText,
  canonicalReleaseEvidence,
  P0ReleaseGateError,
  sha256Utf8,
} from "./p0-release-evidence.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const profile = p0ReleaseEvidenceProfile;
const revision = capture("git", ["rev-parse", "HEAD"]);
const prefix = `erdiagram-p0-release-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const image = `${prefix}-image:0.1.0`;
const network = `${prefix}-network`;
const backupVolume = `${prefix}-backup`;
const sourceVolume = `${prefix}-source`;
const restoredVolume = `${prefix}-restored`;
const sourceContainer = `${prefix}-source-app`;
const restoredContainer = `${prefix}-restored-app`;
const restartContainer = `${prefix}-restart-app`;
const created = {
  image: false,
  network: false,
  volumes: new Set(),
  containers: new Set(),
};
const assertions = new Set();
const dbmlSentinel = `P0_PRIVATE_DBML_${randomUUID()}`;
const retainedSqlSentinel = `P0_RETAINED_SQL_${randomUUID()}`;
const retainedSql = [
  "CREATE TABLE public.release_audit (",
  "  id bigint PRIMARY KEY,",
  "  message text NOT NULL",
  ");",
  `INSERT INTO public.release_audit (id, message) VALUES (1, '${retainedSqlSentinel}');`,
  "",
].join("\n");
const retainedSqlHash = sha256Utf8(retainedSql);

try {
  const evidence = await runGate();
  assert.deepEqual(Object.keys(evidence).sort(compareCodeUnits), [
    ...profile.evidence.requiredFields,
  ]);
  const serializedEvidence = canonicalReleaseEvidence(evidence);
  assertRedactedText(serializedEvidence, [
    dbmlSentinel,
    retainedSqlSentinel,
    retainedSql,
    prefix,
    "/data/er-diagram.sqlite",
  ]);
  process.stdout.write(serializedEvidence);
} catch (error) {
  const code = error instanceof P0ReleaseGateError ? error.code : "P0_RELEASE_GATE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
}

async function runGate() {
  if (capture("docker", ["context", "show"]) !== profile.release.requiredDockerContext) {
    throw new P0ReleaseGateError("P0_RELEASE_DOCKER_CONTEXT_INVALID");
  }
  pass("ORBSTACK_CONTEXT");
  if (capture("git", ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new P0ReleaseGateError("P0_RELEASE_WORKTREE_DIRTY");
  }

  buildCandidateImage();
  const imageConfigDigest = verifyCandidateImage();
  pass("IMAGE_SOURCE_MAPPING");

  createDockerResources();
  const sourceBaseUrl = startApplication(sourceContainer, sourceVolume, true);
  await waitForReady(sourceBaseUrl);
  await assertRuntimeIdentity(sourceBaseUrl);
  const seeded = await seedDurableState(sourceBaseUrl);
  const beforeProbe = databaseProbe(sourceContainer);
  assertInventory(beforeProbe.inventory, profile.inventory);
  assert.equal(beforeProbe.retainedSqlSha256, retainedSqlHash);
  assert.equal(beforeProbe.projects.length, 2);
  assert.equal(beforeProbe.invalidProjects, 1);
  assert.equal(beforeProbe.sqlImportProjects, 1);
  pass("PROJECT_AND_REVISION_IDENTITY");
  pass("INVALID_DRAFT_LAST_VALID");
  pass("LAYOUT_PRESERVED");
  pass("VISUAL_RECEIPT");
  pass("IMPORT_ARTIFACT_RETAINED_SQL");
  pass("APP_METADATA_AND_MIGRATIONS");

  const backupResult = parseJson(
    captureDocker([
      "exec",
      sourceContainer,
      "node",
      "dist/volume-recovery-cli.js",
      "backup",
      "--database",
      "/data/er-diagram.sqlite",
      "--output",
      "/backup/snapshot",
    ]),
  );
  assert.equal(backupResult.ok, true);
  assertInventory(backupResult.manifest?.inventory, profile.inventory);
  pass("BACKUP_WHILE_RUNNING");

  const sourceLogs = captureDocker(["logs", sourceContainer]);
  assertRedactedText(sourceLogs, [
    dbmlSentinel,
    retainedSqlSentinel,
    retainedSql,
    "/data/er-diagram.sqlite",
    sourceContainer,
    sourceVolume,
    backupVolume,
  ]);

  removeContainer(sourceContainer);
  removeVolume(sourceVolume);
  pass("SOURCE_VOLUME_REMOVED");

  const dryRun = parseJson(
    captureDocker([
      "run",
      "--rm",
      "--volume",
      `${backupVolume}:/backup:ro`,
      "--volume",
      `${restoredVolume}:/data`,
      "--entrypoint",
      "node",
      image,
      "dist/volume-recovery-cli.js",
      "restore",
      "--backup",
      "/backup/snapshot",
      "--database",
      "/data/er-diagram.sqlite",
    ]),
  );
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.mode, "DRY_RUN");
  assert.equal(dryRun.plan.expectedTargetDatabaseSha256, null);
  assert.equal(dryRun.plan.sourceBackupHash, backupResult.manifest.backupHash);

  const applied = parseJson(
    captureDocker([
      "run",
      "--rm",
      "--volume",
      `${backupVolume}:/backup:ro`,
      "--volume",
      `${restoredVolume}:/data`,
      "--entrypoint",
      "node",
      image,
      "dist/volume-recovery-cli.js",
      "restore",
      "--backup",
      "/backup/snapshot",
      "--database",
      "/data/er-diagram.sqlite",
      "--apply",
      "--plan-hash",
      dryRun.plan.planHash,
    ]),
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.mode, "APPLY");
  assert.equal(applied.applied, true);
  assert.equal(applied.plan.planHash, dryRun.plan.planHash);
  pass("RESTORE_PLAN_APPLIED");

  const restoredBaseUrl = startApplication(restoredContainer, restoredVolume, false);
  await waitForReady(restoredBaseUrl);
  await assertRuntimeIdentity(restoredBaseUrl);
  await assertApiState(restoredBaseUrl, seeded);
  const restoredProbe = databaseProbe(restoredContainer);
  assert.deepEqual(restoredProbe, beforeProbe);

  removeContainer(restoredContainer);
  const restartBaseUrl = startApplication(restartContainer, restoredVolume, false);
  await waitForReady(restartBaseUrl);
  await assertRuntimeIdentity(restartBaseUrl);
  await assertApiState(restartBaseUrl, seeded);
  assert.deepEqual(databaseProbe(restartContainer), beforeProbe);
  pass("TARGET_RESTART");

  const orderedAssertions = [...assertions].sort(compareCodeUnits);
  assert.deepEqual(orderedAssertions, [...profile.assertions]);
  return {
    evidenceVersion: profile.evidenceVersion,
    releaseState: profile.releaseState,
    version: profile.release.version,
    revision,
    imageReference: profile.release.imageReference,
    imageConfigDigest,
    backupHash: backupResult.manifest.backupHash,
    recoveryPlanHash: dryRun.plan.planHash,
    sourceDatabaseSha256: backupResult.manifest.database.sha256,
    candidateDatabaseSha256: dryRun.plan.candidateDatabaseSha256,
    inventory: assertInventory(beforeProbe.inventory, profile.inventory),
    assertions: orderedAssertions,
    profileHash: P0_RELEASE_EVIDENCE_PROFILE_HASH,
  };
}

function buildCandidateImage() {
  run("docker", [
    "build",
    "--tag",
    image,
    "--build-arg",
    "OCI_SOURCE=https://github.com/hojooo/ER-Diagram",
    "--build-arg",
    `OCI_REVISION=${revision}`,
    "--build-arg",
    `OCI_VERSION=${profile.release.version}`,
    "--build-arg",
    "RUNTIME_RELEASE_CHANNEL=RELEASE",
    "--build-arg",
    `RUNTIME_RELEASE_VERSION=${profile.release.version}`,
    "--build-arg",
    `RUNTIME_RELEASE_SOURCE_REVISION=${revision}`,
    "--build-arg",
    `RUNTIME_RELEASE_IMAGE_REFERENCE=${profile.release.imageReference}`,
    repositoryRoot,
  ]);
  created.image = true;
}

function verifyCandidateImage() {
  const config = parseJson(
    captureDocker(["image", "inspect", image, "--format", "{{json .Config}}"]),
  );
  const labels = config.Labels ?? {};
  assert.equal(config.User, "node");
  assert.equal(labels["org.opencontainers.image.version"], profile.release.version);
  assert.equal(labels["org.opencontainers.image.revision"], revision);
  assert.equal(labels["org.opencontainers.image.licenses"], "Apache-2.0");
  const digest = captureDocker(["image", "inspect", image, "--format", "{{.Id}}"]);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  return digest.slice("sha256:".length);
}

function createDockerResources() {
  run("docker", ["network", "create", network]);
  created.network = true;
  for (const volume of [backupVolume, sourceVolume, restoredVolume]) {
    run("docker", ["volume", "create", volume]);
    created.volumes.add(volume);
  }
  run("docker", [
    "run",
    "--rm",
    "--user",
    "root",
    "--volume",
    `${backupVolume}:/backup`,
    "--entrypoint",
    "chown",
    image,
    "1000:1000",
    "/backup",
  ]);
}

function startApplication(container, volume, mountBackup) {
  const args = [
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    network,
    "--publish",
    "127.0.0.1::8080",
    "--volume",
    `${volume}:/data`,
  ];
  if (mountBackup) args.push("--volume", `${backupVolume}:/backup`);
  args.push(image);
  captureDocker(args);
  created.containers.add(container);
  const published = captureDocker(["port", container, "8080/tcp"]);
  const match = published.match(/127\.0\.0\.1:(\d+)/u);
  if (!match) throw new P0ReleaseGateError("P0_RELEASE_CONTAINER_PORT_INVALID");
  return `http://127.0.0.1:${match[1]}`;
}

async function seedDurableState(baseUrl) {
  const originalSource = [
    `// ${dbmlSentinel}`,
    "Table public.release_accounts {",
    "  id bigint [pk]",
    "}",
    "",
  ].join("\n");
  const createdProject = await requestJson(baseUrl, "/api/v1/projects", 201, {
    method: "POST",
    body: {
      operation: "CREATE",
      commandId: randomUUID(),
      name: "P0 release recovery",
      primaryDialect: "POSTGRESQL",
      source: originalSource,
    },
  });
  const projectId = createdProject.state.project.id;
  const visual = await requestJson(baseUrl, `/api/v1/projects/${projectId}/visual-commands`, 200, {
    method: "POST",
    body: {
      commandId: randomUUID(),
      expectedSchemaRevisionNo: 1,
      kind: "CREATE_COLUMN",
      targetTableKey: 'table:["public","release_accounts"]',
      column: {
        name: "display_name",
        type: "varchar",
        primaryKey: false,
        unique: false,
        notNull: true,
        default: null,
        increment: false,
        note: null,
      },
    },
  });
  assert.equal(visual.revisionCreated, true);
  assert.equal(visual.state.project.schemaRevisionNo, 2);

  const layout = await requestJson(baseUrl, `/api/v1/projects/${projectId}/layouts/GLOBAL`, 200, {
    method: "PUT",
    body: {
      commandId: randomUUID(),
      expectedLayoutRevisionNo: 0,
      layout: {
        positions: { 'table:["public","release_accounts"]': { x: 120, y: 240 } },
        collapsedGroupKeys: [],
        hiddenElementKeys: [],
        viewport: { x: 11, y: 22, zoom: 0.9 },
        detailLevel: "FULL",
        baseSchemaHash: visual.state.project.draftHash,
      },
    },
  });
  assert.equal(layout.state.currentLayoutRevisionNo, 1);

  const invalidSource = `${visual.state.project.draftSource}\nTable release_broken {`;
  const invalid = await requestJson(baseUrl, `/api/v1/projects/${projectId}/draft`, 200, {
    method: "PUT",
    body: {
      commandId: randomUUID(),
      expectedSchemaRevisionNo: 2,
      source: invalidSource,
    },
  });
  assert.equal(invalid.state.currentRevision.validity, "INVALID");
  assert.equal(invalid.state.lastValidRevision?.revisionNo, 2);
  assert.equal(invalid.state.project.schemaRevisionNo, 3);

  const preview = await requestJson(baseUrl, "/api/v1/sql-import/preview", 200, {
    method: "POST",
    body: {
      commandId: randomUUID(),
      dialect: "POSTGRESQL",
      source: retainedSql,
      originalSqlRetention: "RETAIN",
    },
  });
  assert.equal(preview.previewStatus, "PREVIEWED");
  assert.equal(preview.policy.applyReadiness, "DATA_EXCLUSION_CONFIRMATION_REQUIRED");
  const imported = await requestJson(baseUrl, "/api/v1/projects", 201, {
    method: "POST",
    body: {
      operation: "CREATE_FROM_SQL_IMPORT",
      commandId: randomUUID(),
      name: "P0 retained SQL import",
      primaryDialect: "POSTGRESQL",
      source: retainedSql,
      previewHash: preview.previewHash,
      originalSqlRetention: "RETAIN",
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    },
  });
  assert.equal(imported.state.currentRevision.origin, "SQL_IMPORT");
  assert.equal(imported.state.project.schemaRevisionNo, 1);

  return {
    projectId,
    importedProjectId: imported.state.project.id,
    projectStateHash: stateHash(invalid.state),
    importedStateHash: stateHash(imported.state),
    layoutHash: stateHash(layout.state),
  };
}

async function assertApiState(baseUrl, expected) {
  const project = await requestJson(baseUrl, `/api/v1/projects/${expected.projectId}`, 200);
  const imported = await requestJson(
    baseUrl,
    `/api/v1/projects/${expected.importedProjectId}`,
    200,
  );
  const layout = await requestJson(
    baseUrl,
    `/api/v1/projects/${expected.projectId}/layouts/GLOBAL`,
    200,
  );
  assert.equal(stateHash(project.state), expected.projectStateHash);
  assert.equal(stateHash(imported.state), expected.importedStateHash);
  assert.equal(stateHash(layout), expected.layoutHash);
}

async function assertRuntimeIdentity(baseUrl) {
  const runtime = await requestJson(baseUrl, "/api/v1/runtime-config", 200);
  assert.deepEqual(runtime.release, {
    channel: "RELEASE",
    version: profile.release.version,
    sourceRevision: revision,
    imageReference: profile.release.imageReference,
    parserVersion: "9.1.1",
    bundleSchemaVersion: 1,
  });
}

function databaseProbe(container) {
  const result = parseJson(
    captureDocker(["exec", container, "node", "--input-type=module", "-e", databaseProbeSource()]),
  );
  assert.match(result.stateHash, /^[0-9a-f]{64}$/u);
  assert.match(result.retainedSqlSha256, /^[0-9a-f]{64}$/u);
  return result;
}

function databaseProbeSource() {
  return `
    import { createHash } from "node:crypto";
    import Database from "better-sqlite3";
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    const bytes = (value) => Buffer.byteLength(value, "utf8");
    const db = new Database("/data/er-diagram.sqlite", { readonly: true, fileMustExist: true });
    try {
      const projects = db.prepare("SELECT id, name, primary_dialect AS primaryDialect, draft_source AS draftSource, draft_hash AS draftHash, last_valid_revision_id AS lastValidRevisionId, parser_version AS parserVersion, schema_revision_no AS schemaRevisionNo, layout_revision_no AS layoutRevisionNo, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY id").all().map(({ draftSource, ...row }) => ({ ...row, draftSourceBytes: bytes(draftSource), draftSourceSha256: sha(draftSource) }));
      const revisions = db.prepare("SELECT id, project_id AS projectId, revision_no AS revisionNo, source, source_hash AS sourceHash, validity, origin, parser_version AS parserVersion, diagnostic_summary_json AS diagnosticSummary, created_at AS createdAt FROM schema_revisions ORDER BY project_id, revision_no").all().map(({ source, ...row }) => ({ ...row, sourceBytes: bytes(source), sourceSha256: sha(source) }));
      const layouts = db.prepare("SELECT project_id AS projectId, view_key AS viewKey, positions_json AS positions, collapsed_group_keys_json AS collapsedGroupKeys, hidden_element_keys_json AS hiddenElementKeys, viewport_json AS viewport, detail_level AS detailLevel, base_schema_hash AS baseSchemaHash, revision_no AS revisionNo FROM diagram_layouts ORDER BY project_id, view_key").all();
      const artifacts = db.prepare("SELECT id, project_id AS projectId, dialect, original_sql AS originalSql, original_hash AS originalHash, generated_dbml AS generatedDbml, parser_version AS parserVersion, report_json AS report, status, created_at AS createdAt, applied_at AS appliedAt FROM import_artifacts ORDER BY id").all().map(({ originalSql, generatedDbml, report, ...row }) => ({ ...row, originalSqlBytes: originalSql === null ? null : bytes(originalSql), originalSqlSha256: originalSql === null ? null : sha(originalSql), generatedDbmlSha256: generatedDbml === null ? null : sha(generatedDbml), reportSha256: sha(report) }));
      const receipts = db.prepare("SELECT project_id AS projectId, command_id AS commandId, command_kind AS commandKind, command_hash AS commandHash, expected_schema_revision_no AS expectedSchemaRevisionNo, applied_schema_revision_no AS appliedSchemaRevisionNo, applied_layout_revision_no AS appliedLayoutRevisionNo, revision_created AS revisionCreated, layout_migrated AS layoutMigrated, created_at AS createdAt FROM visual_command_receipts ORDER BY project_id, command_id").all();
      const metadata = db.prepare("SELECT key, value FROM app_metadata ORDER BY key").all();
      const migrations = db.prepare("SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, hash").all();
      const state = { projects, revisions, layouts, artifacts, receipts, metadata, migrations };
      console.log(JSON.stringify({
        inventory: {
          projects: projects.length,
          schemaRevisions: revisions.length,
          diagramLayouts: layouts.length,
          importArtifacts: artifacts.length,
          visualCommandReceipts: receipts.length,
          appMetadata: metadata.length,
          drizzleMigrations: migrations.length,
        },
        invalidProjects: projects.filter((project) => revisions.some((revision) => revision.projectId === project.id && revision.revisionNo === project.schemaRevisionNo && revision.validity === "INVALID") && revisions.some((revision) => revision.id === project.lastValidRevisionId && revision.validity === "VALID")).length,
        sqlImportProjects: projects.filter((project) => revisions.some((revision) => revision.projectId === project.id && revision.origin === "SQL_IMPORT")).length,
        retainedSqlSha256: artifacts.find((artifact) => artifact.originalSqlSha256 !== null)?.originalSqlSha256 ?? null,
        projects: projects.map(({ id, draftHash, lastValidRevisionId, schemaRevisionNo, layoutRevisionNo }) => ({ id, draftHash, lastValidRevisionId, schemaRevisionNo, layoutRevisionNo })),
        stateHash: sha(JSON.stringify(state)),
      }));
    } finally {
      db.close();
    }
  `;
}

async function requestJson(baseUrl, pathname, expectedStatus, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new P0ReleaseGateError("P0_RELEASE_HTTP_FAILED");
  }
  if (response.status !== expectedStatus) {
    throw new P0ReleaseGateError("P0_RELEASE_HTTP_STATUS_INVALID");
  }
  try {
    return await response.json();
  } catch {
    throw new P0ReleaseGateError("P0_RELEASE_HTTP_RESPONSE_INVALID");
  }
}

async function waitForReady(baseUrl) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.status === 200) return;
    } catch {
      // Startup connection failures are expected until the listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new P0ReleaseGateError("P0_RELEASE_SERVER_NOT_READY");
}

function stateHash(value) {
  return sha256Utf8(JSON.stringify(value));
}

function pass(assertionId) {
  if (!profile.assertions.includes(assertionId) || assertions.has(assertionId)) {
    throw new P0ReleaseGateError("P0_RELEASE_ASSERTION_INVALID");
  }
  assertions.add(assertionId);
}

function removeContainer(container) {
  if (!created.containers.has(container)) return;
  assertOwnedResourceName(container, prefix);
  run("docker", ["rm", "--force", container]);
  created.containers.delete(container);
}

function removeVolume(volume) {
  if (!created.volumes.has(volume)) return;
  assertOwnedResourceName(volume, prefix);
  run("docker", ["volume", "rm", volume]);
  created.volumes.delete(volume);
}

function cleanup() {
  for (const container of [...created.containers]) {
    try {
      assertOwnedResourceName(container, prefix);
      run("docker", ["rm", "--force", container]);
    } catch {
      // Cleanup is best-effort and remains restricted to the test-owned prefix.
    }
  }
  for (const volume of [...created.volumes]) {
    try {
      assertOwnedResourceName(volume, prefix);
      run("docker", ["volume", "rm", volume]);
    } catch {
      // Cleanup is best-effort and remains restricted to the test-owned prefix.
    }
  }
  if (created.network) {
    try {
      assertOwnedResourceName(network, prefix);
      run("docker", ["network", "rm", network]);
    } catch {
      // Cleanup is best-effort and remains restricted to the test-owned prefix.
    }
  }
  if (created.image) {
    try {
      if (!image.startsWith(`${prefix}-image:`)) {
        throw new P0ReleaseGateError("P0_RELEASE_CLEANUP_SCOPE_INVALID");
      }
      run("docker", ["image", "rm", "--force", image]);
    } catch {
      // Cleanup is best-effort and remains restricted to the test-owned prefix.
    }
  }
}

function captureDocker(args) {
  return capture("docker", args);
}

function capture(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new P0ReleaseGateError("P0_RELEASE_COMMAND_FAILED");
  }
}

function run(command, args) {
  try {
    execFileSync(command, args, {
      cwd: repositoryRoot,
      maxBuffer: 32 * 1024 * 1024,
      stdio: "ignore",
    });
  } catch {
    throw new P0ReleaseGateError("P0_RELEASE_COMMAND_FAILED");
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new P0ReleaseGateError("P0_RELEASE_JSON_INVALID");
  }
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

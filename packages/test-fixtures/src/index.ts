export const testFixturesPackage = "@er-diagram/test-fixtures";

export type {
  P0AcceptanceProfile,
  P0AcceptanceReleaseGate,
  P0ReleaseGateId,
} from "./p0-acceptance-profile.js";
export {
  P0_ACCEPTANCE_PROFILE_HASH,
  P0_ACCEPTANCE_PROFILE_VERSION,
  p0AcceptanceProfile,
} from "./p0-acceptance-profile.js";

export type {
  M4PerformanceProfile,
  PerformanceFixtureEvidence,
} from "./performance-profile.js";
export {
  M4_PERFORMANCE_PROFILE_HASH,
  M4_PERFORMANCE_PROFILE_VERSION,
  m4PerformanceProfile,
} from "./performance-profile.js";

export type { ProjectBundleFixture } from "./project-bundle-fixtures.js";
export {
  PROJECT_BUNDLE_FIXTURE_SET_HASH,
  PROJECT_BUNDLE_FIXTURE_VERSION,
  projectBundleFixture,
} from "./project-bundle-fixtures.js";
export type {
  SqlCapabilityFixture,
  SqlFixtureCapabilityId,
  SqlFixtureCapabilityStatus,
  SqlFixtureDialect,
  SqlFixtureInventory,
  SqlFixtureObservedOutcome,
  SqlParserErrorFixture,
} from "./sql-capability-fixtures.js";
export {
  SQL_CAPABILITY_FIXTURE_SET_HASH,
  SQL_CAPABILITY_FIXTURE_VERSION,
  sqlCapabilityFixtures,
  sqlParserErrorFixtures,
} from "./sql-capability-fixtures.js";
export type {
  SqlExportFixture,
  SqlExportFixtureStatus,
} from "./sql-export-fixtures.js";
export {
  SQL_EXPORT_FIXTURE_SET_HASH,
  SQL_EXPORT_FIXTURE_VERSION,
  sqlExportFixtures,
} from "./sql-export-fixtures.js";
export type {
  SqlImportFixtureClause,
  SqlImportFixtureStatement,
  SqlImportFixtureStatementKind,
  SqlImportReportFixture,
} from "./sql-import-report-fixtures.js";
export {
  SQL_IMPORT_REPORT_FIXTURE_SET_HASH,
  SQL_IMPORT_REPORT_FIXTURE_VERSION,
  sqlImportReportFixtures,
} from "./sql-import-report-fixtures.js";
export type { SqlInterchangeGateFixture } from "./sql-interchange-gate-fixtures.js";
export {
  SQL_INTERCHANGE_GATE_FIXTURE_SET_HASH,
  SQL_INTERCHANGE_GATE_FIXTURE_VERSION,
  sqlInterchangeGateFixtures,
} from "./sql-interchange-gate-fixtures.js";
export type { FixtureInventory, FixtureKind } from "./synthetic-fixtures.js";
export {
  DEFAULT_FIXTURE_SEED,
  fixtureInventory,
  generateFidelityFixture,
  generateScaleFixture,
  sha256FixtureSource,
} from "./synthetic-fixtures.js";
export type {
  VisualCommandGateCase,
  VisualCommandGateCommandKind,
  VisualCommandGateFixture,
  VisualCommandGateOutcome,
  VisualCommandGateSemanticSummary,
  VisualCommandGateStep,
} from "./visual-command-gate-fixtures.js";
export {
  VISUAL_COMMAND_GATE_FIXTURE_SET_HASH,
  VISUAL_COMMAND_GATE_FIXTURE_VERSION,
  visualCommandGateFixture,
} from "./visual-command-gate-fixtures.js";

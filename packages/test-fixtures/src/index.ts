export const testFixturesPackage = "@er-diagram/test-fixtures";

export type { FixtureInventory, FixtureKind } from "./synthetic-fixtures.js";
export {
  DEFAULT_FIXTURE_SEED,
  fixtureInventory,
  generateFidelityFixture,
  generateScaleFixture,
  sha256FixtureSource,
} from "./synthetic-fixtures.js";
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

import { createHash } from "node:crypto";

import type {
  SqlFixtureCapabilityId,
  SqlFixtureCapabilityStatus,
  SqlFixtureDialect,
} from "./sql-capability-fixtures.js";

export const SQL_IMPORT_REPORT_FIXTURE_VERSION = 1 as const;

export type SqlImportFixtureStatementKind =
  | "CREATE_SCHEMA"
  | "CREATE_TABLE"
  | "CREATE_ENUM"
  | "CREATE_INDEX"
  | "ALTER_TABLE"
  | "COMMENT"
  | "VIEW"
  | "DROP"
  | "TRIGGER"
  | "ROUTINE"
  | "DML"
  | "COPY"
  | "UNKNOWN";

export interface SqlImportFixtureClause {
  readonly capabilityId: SqlFixtureCapabilityId | null;
  readonly status: Exclude<SqlFixtureCapabilityStatus, "NOT_APPLICABLE">;
  readonly sourceFragment: string;
}

export interface SqlImportFixtureStatement {
  readonly kind: SqlImportFixtureStatementKind;
  readonly status: Exclude<SqlFixtureCapabilityStatus, "NOT_APPLICABLE">;
  readonly sourceFragment: string;
  readonly clauses: readonly SqlImportFixtureClause[];
}

export interface SqlImportReportFixture {
  readonly id: string;
  readonly dialect: SqlFixtureDialect;
  readonly filepath: string;
  readonly source: string;
  readonly sourceHash: string;
  readonly expectedOverallStatus: Exclude<SqlFixtureCapabilityStatus, "NOT_APPLICABLE">;
  readonly expectedApplyEligible: boolean;
  readonly expectedStatements: readonly SqlImportFixtureStatement[];
}

const postgresqlSource = `-- synthetic SQL import report fixture
CREATE SCHEMA app;
CREATE TYPE app.mood AS ENUM ('happy', 'sad');
CREATE TABLE app.accounts (
  id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10) PRIMARY KEY,
  mood app.mood[] NOT NULL,
  computed_value bigint GENERATED ALWAYS AS (id * 2) STORED
) TABLESPACE pg_default;
CREATE INDEX accounts_mood_idx ON app.accounts (lower(mood)) WHERE mood IS NOT NULL;
CREATE VIEW app.account_view AS SELECT id FROM app.accounts;
`;

const mysqlSource = `CREATE TABLE app.accounts (
  id bigint AUTO_INCREMENT PRIMARY KEY,
  status enum('active', 'disabled') NOT NULL,
  computed_value bigint GENERATED ALWAYS AS (id * 2) STORED,
  UNIQUE KEY accounts_status_uq (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE app.accounts ADD CONSTRAINT accounts_status_unique UNIQUE (status);
INSERT INTO app.accounts (id, status) VALUES (1, 'active');
`;

export const sqlImportReportFixtures: readonly SqlImportReportFixture[] = [
  fixture({
    id: "mysql-mixed-report",
    dialect: "MYSQL",
    filepath: "synthetic/mysql-import.sql",
    source: mysqlSource,
    expectedOverallStatus: "UNSUPPORTED",
    expectedApplyEligible: false,
    expectedStatements: [
      statement("CREATE_TABLE", "PARTIAL", sourceStatement(mysqlSource, "CREATE TABLE"), [
        clause("SCHEMA_QUALIFIED_TABLE", "EXACT", "app.accounts"),
        clause("AUTO_INCREMENT", "NORMALIZED", "AUTO_INCREMENT"),
        clause("BASIC_CONSTRAINTS", "EXACT", "PRIMARY KEY"),
        clause("ENUM", "NORMALIZED", "enum('active', 'disabled')"),
        clause("BASIC_CONSTRAINTS", "EXACT", "NOT NULL"),
        clause("GENERATED_COLUMN", "PARTIAL", "GENERATED ALWAYS AS (id * 2) STORED"),
        clause("MYSQL_INDEXES", "EXACT", "UNIQUE KEY accounts_status_uq (status)"),
        clause(
          "MYSQL_TABLE_OPTIONS",
          "PARTIAL",
          "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        ),
      ]),
      statement("ALTER_TABLE", "UNSUPPORTED", sourceStatement(mysqlSource, "ALTER TABLE"), [
        clause(
          "ALTER_ADD_UNIQUE",
          "UNSUPPORTED",
          "ADD CONSTRAINT accounts_status_unique UNIQUE (status)",
        ),
      ]),
      statement("DML", "UNSUPPORTED", sourceStatement(mysqlSource, "INSERT INTO"), []),
    ],
  }),
  fixture({
    id: "postgresql-mixed-report",
    dialect: "POSTGRESQL",
    filepath: "/synthetic/postgresql-import.sql",
    source: postgresqlSource,
    expectedOverallStatus: "UNSUPPORTED",
    expectedApplyEligible: true,
    expectedStatements: [
      statement("CREATE_SCHEMA", "EXACT", sourceStatement(postgresqlSource, "CREATE SCHEMA"), []),
      statement("CREATE_ENUM", "EXACT", sourceStatement(postgresqlSource, "CREATE TYPE"), []),
      statement("CREATE_TABLE", "PARTIAL", sourceStatement(postgresqlSource, "CREATE TABLE"), [
        clause("SCHEMA_QUALIFIED_TABLE", "EXACT", "app.accounts"),
        clause("IDENTITY", "PARTIAL", "GENERATED ALWAYS AS IDENTITY (START WITH 10)"),
        clause("BASIC_CONSTRAINTS", "EXACT", "PRIMARY KEY"),
        clause("ARRAY_SCHEMA_ENUM", "PARTIAL", "app.mood[]"),
        clause("BASIC_CONSTRAINTS", "EXACT", "NOT NULL"),
        clause("GENERATED_COLUMN", "PARTIAL", "GENERATED ALWAYS AS (id * 2) STORED"),
        clause("TABLESPACE", "PARTIAL", "TABLESPACE pg_default"),
      ]),
      statement("CREATE_INDEX", "PARTIAL", sourceStatement(postgresqlSource, "CREATE INDEX"), [
        clause("FUNCTION_INDEX", "EXACT", "lower(mood)"),
        clause("PARTIAL_INDEX", "PARTIAL", "WHERE mood IS NOT NULL"),
      ]),
      statement("VIEW", "UNSUPPORTED", sourceStatement(postgresqlSource, "CREATE VIEW"), []),
    ],
  }),
].sort((left, right) => compareCodeUnits(left.id, right.id));

export const SQL_IMPORT_REPORT_FIXTURE_SET_HASH = sha256(
  JSON.stringify({
    version: SQL_IMPORT_REPORT_FIXTURE_VERSION,
    fixtures: sqlImportReportFixtures,
  }),
);

function fixture(input: Omit<SqlImportReportFixture, "sourceHash">): SqlImportReportFixture {
  return { ...input, sourceHash: sha256(input.source) };
}

function statement(
  kind: SqlImportFixtureStatementKind,
  status: SqlImportFixtureStatement["status"],
  sourceFragment: string,
  clauses: readonly SqlImportFixtureClause[],
): SqlImportFixtureStatement {
  return { kind, status, sourceFragment, clauses };
}

function clause(
  capabilityId: SqlFixtureCapabilityId | null,
  status: SqlImportFixtureClause["status"],
  sourceFragment: string,
): SqlImportFixtureClause {
  return { capabilityId, status, sourceFragment };
}

function sourceStatement(source: string, prefix: string): string {
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error(`Missing fixture statement: ${prefix}`);
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error(`Unterminated fixture statement: ${prefix}`);
  return source.slice(start, end + 1);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

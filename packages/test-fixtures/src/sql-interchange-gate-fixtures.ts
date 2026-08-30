import { createHash } from "node:crypto";

import type {
  SqlFixtureCapabilityStatus,
  SqlFixtureDialect,
  SqlFixtureInventory,
} from "./sql-capability-fixtures.js";

export const SQL_INTERCHANGE_GATE_FIXTURE_VERSION = 1 as const;

export interface SqlInterchangeGateFixture {
  readonly id: string;
  readonly dialect: SqlFixtureDialect;
  readonly source: string;
  readonly sourceHash: string;
  readonly rowSentinel: string;
  readonly dataStatementHandling: "CONFIRM_DDL_ONLY";
  readonly expectedImportOverallStatus: Exclude<SqlFixtureCapabilityStatus, "NOT_APPLICABLE">;
  readonly expectedImportNonExactCodes: readonly string[];
  readonly expectedCandidateDbmlHash: string;
  readonly expectedCandidateSchemaHash: string;
  readonly expectedExportOverallStatus: Exclude<SqlFixtureCapabilityStatus, "NOT_APPLICABLE">;
  readonly expectedExportEntryCodes: readonly string[];
  readonly expectedGeneratedSqlHash: string;
  readonly expectedExportableSchemaHash: string;
  readonly expectedInventory: SqlFixtureInventory;
}

const POSTGRESQL_ROW_SENTINEL = "M2_GATE_POSTGRESQL_ROW_SENTINEL";
const MYSQL_ROW_SENTINEL = "M2_GATE_MYSQL_ROW_SENTINEL";

const postgresqlSource = `CREATE SCHEMA gate;
CREATE TYPE gate.account_status AS ENUM ('active', 'disabled');
CREATE TABLE gate.accounts (
  tenant_id bigint NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10),
  status gate.account_status NOT NULL DEFAULT 'active',
  email text NOT NULL UNIQUE DEFAULT 'unknown',
  PRIMARY KEY (tenant_id, id),
  CHECK (length(email) > 3)
);
CREATE TABLE gate.memberships (
  tenant_id bigint NOT NULL,
  account_id bigint NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  CONSTRAINT memberships_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES gate.accounts (tenant_id, id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT
);
CREATE INDEX memberships_role_lower_idx ON gate.memberships (lower(role));
COMMENT ON TABLE gate.accounts IS 'Gate accounts';
COMMENT ON COLUMN gate.accounts.email IS 'Gate email';
INSERT INTO gate.accounts (tenant_id, id, status, email)
VALUES (1, 10, 'active', '${POSTGRESQL_ROW_SENTINEL}');
`;

const mysqlSource = `CREATE TABLE gate.accounts (
  tenant_id bigint NOT NULL,
  id bigint NOT NULL AUTO_INCREMENT,
  status enum('active', 'disabled') NOT NULL,
  email varchar(255) NOT NULL UNIQUE COMMENT 'Gate email',
  PRIMARY KEY (tenant_id, id),
  CHECK (char_length(email) > 3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Gate accounts';
CREATE TABLE gate.memberships (
  tenant_id bigint NOT NULL,
  account_id bigint NOT NULL,
  role varchar(32) NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  INDEX memberships_role_idx (role),
  CONSTRAINT memberships_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES gate.accounts (tenant_id, id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO gate.accounts (tenant_id, id, status, email)
VALUES (1, 10, 'active', '${MYSQL_ROW_SENTINEL}');
`;

export const sqlInterchangeGateFixtures: readonly SqlInterchangeGateFixture[] = [
  fixture({
    id: "mysql-interchange-gate",
    dialect: "MYSQL",
    source: mysqlSource,
    rowSentinel: MYSQL_ROW_SENTINEL,
    expectedImportOverallStatus: "UNSUPPORTED",
    expectedImportNonExactCodes: [
      "SQL_PARTIAL_STATEMENT",
      "SQL_NORMALIZED_AUTO_INCREMENT",
      "SQL_NORMALIZED_ENUM",
      "SQL_PARTIAL_MYSQL_TABLE_OPTIONS",
      "SQL_PARTIAL_STATEMENT",
      "SQL_PARTIAL_MYSQL_TABLE_OPTIONS",
      "SQL_UNSUPPORTED_DATA_STATEMENT",
    ],
    expectedCandidateDbmlHash: "56d16c5a047b81b0c70ce136dfd4d7ee27888852cd65f60c6f26d50d5a6e204c",
    expectedCandidateSchemaHash: "ee108f883986383eaee89e8ae0c8e1e9da395e13c02aa97057ead2baad7d7257",
    expectedExportOverallStatus: "PARTIAL",
    expectedExportEntryCodes: [
      "SQL_EXPORT_NORMALIZES_MYSQL_ENUM",
      "SQL_EXPORT_PARTIAL_CARDINALITY",
      "SQL_EXPORT_PARTIAL_MYSQL_TABLE_COMMENT",
    ],
    expectedGeneratedSqlHash: "9f394facd7bdb98b7a20f91cf638361cc9546c9c6988e7427543f33c04d1619e",
    expectedExportableSchemaHash:
      "16559536ae5c92b2e0b857fc4a5cb4fe33a6f9dbf6ba1d47042e629ba852fab6",
    expectedInventory: { tables: 2, enums: 1, references: 1 },
  }),
  fixture({
    id: "postgresql-interchange-gate",
    dialect: "POSTGRESQL",
    source: postgresqlSource,
    rowSentinel: POSTGRESQL_ROW_SENTINEL,
    expectedImportOverallStatus: "UNSUPPORTED",
    expectedImportNonExactCodes: [
      "SQL_PARTIAL_STATEMENT",
      "SQL_PARTIAL_IDENTITY",
      "SQL_UNSUPPORTED_DATA_STATEMENT",
    ],
    expectedCandidateDbmlHash: "22bfa910377466cc23ce1c181be9f9b1e0d9769786d88b8c6dd3b20f188bb75e",
    expectedCandidateSchemaHash: "09a5811138a3c3d894ded02c058dfd56a75e2c8781a8f55b41840df1688f7560",
    expectedExportOverallStatus: "PARTIAL",
    expectedExportEntryCodes: [
      "SQL_EXPORT_NORMALIZES_SQL_SYNTAX",
      "SQL_EXPORT_PARTIAL_CARDINALITY",
    ],
    expectedGeneratedSqlHash: "3b9abbd82dabecc7b32b3fc67f4bd4ba09e08d8bee92fb7a230adbb0469b1070",
    expectedExportableSchemaHash:
      "faa91c96960cfbbfada4364446a45f01a509b35d9bf80c5ebdf25f2e98fc9b84",
    expectedInventory: { tables: 2, enums: 1, references: 1 },
  }),
];

export const SQL_INTERCHANGE_GATE_FIXTURE_SET_HASH = sha256(
  JSON.stringify(sqlInterchangeGateFixtures),
);

function fixture(
  input: Omit<SqlInterchangeGateFixture, "sourceHash" | "dataStatementHandling">,
): SqlInterchangeGateFixture {
  return {
    ...input,
    sourceHash: sha256(input.source),
    dataStatementHandling: "CONFIRM_DDL_ONLY",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

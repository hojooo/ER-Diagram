import type { PrimaryDialect } from "@er-diagram/contracts";
import { DBML_PARSER_VERSION } from "./schema-graph.js";

export const SQL_CAPABILITY_MATRIX_VERSION = 1 as const;

export type ConversionStatus = "EXACT" | "NORMALIZED" | "PARTIAL" | "UNSUPPORTED" | "ERROR";

export type SqlCapabilityStatus = Exclude<ConversionStatus, "ERROR"> | "NOT_APPLICABLE";

export type SqlCapabilityObservedOutcome =
  | "PRESERVED"
  | "NORMALIZED"
  | "PARTIALLY_PRESERVED"
  | "DROPPED"
  | "REJECTED"
  | "EMITS_RECORDS"
  | "NOT_APPLICABLE";

export type SqlCapabilityId =
  | "ALTER_ADD_FOREIGN_KEY"
  | "ALTER_ADD_UNIQUE"
  | "ALTER_COLUMN_MUTATION"
  | "ARRAY_BUILTIN"
  | "ARRAY_SCHEMA_ENUM"
  | "AUTO_INCREMENT"
  | "BASIC_CONSTRAINTS"
  | "COMMENTS"
  | "COMPOSITE_KEYS"
  | "COPY_DATA"
  | "CREATE_TABLE"
  | "DML"
  | "DROP_STATEMENT"
  | "ENUM"
  | "FOREIGN_KEY_ACTIONS"
  | "FUNCTION_INDEX"
  | "GENERATED_COLUMN"
  | "IDENTITY"
  | "INDEX_METHODS"
  | "MYSQL_INDEXES"
  | "MYSQL_TABLE_OPTIONS"
  | "PARTIAL_INDEX"
  | "PROCEDURE_OR_FUNCTION_BODY"
  | "SCHEMA_QUALIFIED_TABLE"
  | "SERIAL"
  | "TABLESPACE"
  | "TRIGGER"
  | "VIEW";

export type SqlCapabilityScope = "STATEMENT" | "CLAUSE";

export interface SqlCapabilityAssessment {
  readonly targetStatus: SqlCapabilityStatus;
  readonly observedStatus: SqlCapabilityStatus;
  readonly observedOutcome: SqlCapabilityObservedOutcome;
}

export interface SqlCapabilityEntry {
  readonly id: SqlCapabilityId;
  readonly scope: SqlCapabilityScope;
  readonly dialects: Readonly<Record<PrimaryDialect, SqlCapabilityAssessment>>;
}

export interface SqlCapabilityMatrix {
  readonly matrixVersion: typeof SQL_CAPABILITY_MATRIX_VERSION;
  readonly parserVersions: {
    readonly dbmlCore: typeof DBML_PARSER_VERSION;
    readonly dbmlParse: typeof DBML_PARSER_VERSION;
  };
  readonly dialectBaselines: {
    readonly POSTGRESQL: {
      readonly minimumVersion: "14";
      readonly parserFormat: "postgres";
      readonly versionDetection: "BASELINE_ONLY";
    };
    readonly MYSQL: {
      readonly minimumVersion: "8.0";
      readonly parserFormat: "mysql";
      readonly versionDetection: "BASELINE_ONLY";
    };
  };
  readonly entries: readonly SqlCapabilityEntry[];
}

const EXACT = assessment("EXACT", "EXACT", "PRESERVED");
const NORMALIZED = assessment("NORMALIZED", "NORMALIZED", "NORMALIZED");
const PARTIAL = assessment("PARTIAL", "PARTIAL", "PARTIALLY_PRESERVED");
const UNSUPPORTED_DROPPED = assessment("UNSUPPORTED", "UNSUPPORTED", "DROPPED");
const UNSUPPORTED_RECORDS = assessment("UNSUPPORTED", "UNSUPPORTED", "EMITS_RECORDS");
const NOT_APPLICABLE = assessment("NOT_APPLICABLE", "NOT_APPLICABLE", "NOT_APPLICABLE");
const POSTGRESQL_IDENTITY_GAP = assessment("NORMALIZED", "PARTIAL", "PARTIALLY_PRESERVED");
const POSTGRESQL_SCHEMA_ENUM_ARRAY_GAP = assessment("EXACT", "PARTIAL", "PARTIALLY_PRESERVED");

const entries: readonly SqlCapabilityEntry[] = [
  entry("ALTER_ADD_FOREIGN_KEY", "CLAUSE", EXACT, EXACT),
  entry("ALTER_ADD_UNIQUE", "CLAUSE", EXACT, UNSUPPORTED_DROPPED),
  entry("ALTER_COLUMN_MUTATION", "STATEMENT", UNSUPPORTED_DROPPED, UNSUPPORTED_DROPPED),
  entry("ARRAY_BUILTIN", "CLAUSE", EXACT, NOT_APPLICABLE),
  entry("ARRAY_SCHEMA_ENUM", "CLAUSE", POSTGRESQL_SCHEMA_ENUM_ARRAY_GAP, NOT_APPLICABLE),
  entry("AUTO_INCREMENT", "CLAUSE", NOT_APPLICABLE, NORMALIZED),
  entry("BASIC_CONSTRAINTS", "CLAUSE", EXACT, EXACT),
  entry("COMMENTS", "CLAUSE", EXACT, EXACT),
  entry("COMPOSITE_KEYS", "CLAUSE", EXACT, EXACT),
  entry("COPY_DATA", "STATEMENT", UNSUPPORTED_DROPPED, NOT_APPLICABLE),
  entry("CREATE_TABLE", "STATEMENT", EXACT, EXACT),
  entry("DML", "STATEMENT", UNSUPPORTED_RECORDS, UNSUPPORTED_RECORDS),
  entry("DROP_STATEMENT", "STATEMENT", UNSUPPORTED_DROPPED, UNSUPPORTED_DROPPED),
  entry("ENUM", "CLAUSE", EXACT, NORMALIZED),
  entry("FOREIGN_KEY_ACTIONS", "CLAUSE", EXACT, EXACT),
  entry("FUNCTION_INDEX", "CLAUSE", EXACT, EXACT),
  entry("GENERATED_COLUMN", "CLAUSE", PARTIAL, PARTIAL),
  entry("IDENTITY", "CLAUSE", POSTGRESQL_IDENTITY_GAP, NOT_APPLICABLE),
  entry("INDEX_METHODS", "CLAUSE", EXACT, NOT_APPLICABLE),
  entry("MYSQL_INDEXES", "CLAUSE", NOT_APPLICABLE, EXACT),
  entry("MYSQL_TABLE_OPTIONS", "CLAUSE", NOT_APPLICABLE, PARTIAL),
  entry("PARTIAL_INDEX", "CLAUSE", PARTIAL, NOT_APPLICABLE),
  entry("PROCEDURE_OR_FUNCTION_BODY", "STATEMENT", UNSUPPORTED_DROPPED, UNSUPPORTED_DROPPED),
  entry("SCHEMA_QUALIFIED_TABLE", "CLAUSE", EXACT, EXACT),
  entry("SERIAL", "CLAUSE", NORMALIZED, NOT_APPLICABLE),
  entry("TABLESPACE", "CLAUSE", PARTIAL, NOT_APPLICABLE),
  entry("TRIGGER", "STATEMENT", UNSUPPORTED_DROPPED, UNSUPPORTED_DROPPED),
  entry("VIEW", "STATEMENT", UNSUPPORTED_DROPPED, UNSUPPORTED_DROPPED),
];

export const sqlCapabilityMatrix: SqlCapabilityMatrix = {
  matrixVersion: SQL_CAPABILITY_MATRIX_VERSION,
  parserVersions: {
    dbmlCore: DBML_PARSER_VERSION,
    dbmlParse: DBML_PARSER_VERSION,
  },
  dialectBaselines: {
    POSTGRESQL: {
      minimumVersion: "14",
      parserFormat: "postgres",
      versionDetection: "BASELINE_ONLY",
    },
    MYSQL: {
      minimumVersion: "8.0",
      parserFormat: "mysql",
      versionDetection: "BASELINE_ONLY",
    },
  },
  entries,
};

export function getSqlCapabilityAssessment(
  capabilityId: SqlCapabilityId,
  dialect: PrimaryDialect,
): SqlCapabilityAssessment {
  const capability = entries.find((candidate) => candidate.id === capabilityId);
  if (!capability) {
    throw new Error(`Unknown SQL capability: ${String(capabilityId)}`);
  }
  return capability.dialects[dialect];
}

function assessment(
  targetStatus: SqlCapabilityStatus,
  observedStatus: SqlCapabilityStatus,
  observedOutcome: SqlCapabilityObservedOutcome,
): SqlCapabilityAssessment {
  return { targetStatus, observedStatus, observedOutcome };
}

function entry(
  id: SqlCapabilityId,
  scope: SqlCapabilityScope,
  postgresql: SqlCapabilityAssessment,
  mysql: SqlCapabilityAssessment,
): SqlCapabilityEntry {
  return {
    id,
    scope,
    dialects: {
      POSTGRESQL: postgresql,
      MYSQL: mysql,
    },
  };
}

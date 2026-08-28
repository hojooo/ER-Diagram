import { ModelExporter, Parser, type Database } from "@dbml/core";
import type { Diagnostic, PrimaryDialect, SourceRange } from "@er-diagram/contracts";
import { parseDbmlV2 } from "./dbml-parser.js";
import { sha256Utf8 } from "./hash.js";
import { DBML_PARSER_VERSION, type SchemaGraph } from "./schema-graph.js";
import { SCHEMA_SEMANTICS_VERSION, type SchemaElementChange } from "./schema-semantics.js";
import {
  type ConversionStatus,
  SQL_CAPABILITY_MATRIX_VERSION,
  type SqlCapabilityId,
} from "./sql-capabilities.js";
import { verifySqlModelToGraph } from "./sql-import-semantics.js";
import { analyzeSqlSource, rangeAtSqlParserPosition, sourceRange } from "./sql-source-analyzer.js";

export const SQL_CONVERSION_REPORT_VERSION = 1 as const;

const DEFAULT_SQL_FILEPATH = "/import.sql";
const CANDIDATE_DBML_FILEPATH = "/candidate.dbml";

const STATUS_RANK: Readonly<Record<ConversionStatus, number>> = {
  EXACT: 0,
  NORMALIZED: 1,
  PARTIAL: 2,
  UNSUPPORTED: 3,
  ERROR: 4,
};

export interface SqlImportConversionInput {
  readonly dialect: PrimaryDialect;
  readonly source: string;
  readonly filepath?: string;
}

export type SqlStatementKind =
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

export interface SqlClauseConversion {
  readonly clauseNo: number;
  readonly capabilityId: SqlCapabilityId | null;
  readonly status: ConversionStatus;
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange;
}

export interface SqlStatementConversion {
  readonly statementNo: number;
  readonly kind: SqlStatementKind;
  readonly capabilityId: SqlCapabilityId | null;
  readonly status: ConversionStatus;
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange;
  readonly clauses: SqlClauseConversion[];
}

export type SqlSemanticVerification =
  | {
      readonly status: "NOT_RUN";
      readonly sourceModelHash: null;
      readonly candidateSchemaHash: null;
      readonly changes: [];
    }
  | {
      readonly status: "VERIFIED";
      readonly sourceModelHash: string;
      readonly candidateSchemaHash: string;
      readonly changes: [];
    }
  | {
      readonly status: "FAILED";
      readonly sourceModelHash: string;
      readonly candidateSchemaHash: string;
      readonly changes: SchemaElementChange[];
    };

export interface ConversionReport {
  readonly reportVersion: typeof SQL_CONVERSION_REPORT_VERSION;
  readonly dialect: PrimaryDialect;
  readonly sourceFilepath: string;
  readonly sourceHash: string;
  readonly parserInputHash: string;
  readonly parserVersions: {
    readonly dbmlCore: typeof DBML_PARSER_VERSION;
    readonly dbmlParse: typeof DBML_PARSER_VERSION;
  };
  readonly capabilityMatrixVersion: typeof SQL_CAPABILITY_MATRIX_VERSION;
  readonly schemaSemanticsVersion: typeof SCHEMA_SEMANTICS_VERSION;
  readonly overallStatus: ConversionStatus;
  readonly applyEligible: boolean;
  readonly candidateDbmlHash: string | null;
  readonly statements: SqlStatementConversion[];
  readonly diagnostics: Diagnostic[];
  readonly semanticVerification: SqlSemanticVerification;
}

export type SqlImportConversionResult =
  | {
      readonly ok: true;
      readonly report: ConversionReport;
      readonly candidate: {
        readonly dbml: string;
        readonly dbmlHash: string;
        readonly graph: SchemaGraph;
      };
    }
  | {
      readonly ok: false;
      readonly report: ConversionReport;
      readonly candidate: null;
    };

export async function convertSqlImport(
  input: SqlImportConversionInput,
): Promise<SqlImportConversionResult> {
  const filepath = input.filepath ?? DEFAULT_SQL_FILEPATH;
  const sourceHash = await sha256Utf8(input.source);
  const parserInputHash = sourceHash;
  const invalidFilepath = filepath.length === 0;
  const analysis = invalidFilepath
    ? { tokens: [], statements: [] }
    : analyzeSqlSource(input.source, filepath, input.dialect);

  if (invalidFilepath) {
    return failedResult(baseReport(input.dialect, filepath, sourceHash, parserInputHash, []), [
      staticDiagnostic("SQL_PARSE_INTERNAL_FILEPATH", "SQL source filepath must not be empty."),
    ]);
  }

  if (analysis.statements.length === 0) {
    return failedResult(baseReport(input.dialect, filepath, sourceHash, parserInputHash, []), [
      staticDiagnostic(
        "SQL_PARSE_EMPTY_INPUT",
        "SQL import requires at least one non-trivia statement.",
        sourceRange(input.source, filepath, input.source.length, input.source.length),
      ),
    ]);
  }

  let database: Database;
  try {
    database = Parser.parse(input.source, parserFormat(input.dialect));
  } catch (error) {
    const diagnostics = parserDiagnostics(
      error,
      input.source,
      filepath,
      input.dialect,
      analysis.tokens,
    );
    return failedResult(
      baseReport(
        input.dialect,
        filepath,
        sourceHash,
        parserInputHash,
        markStatementsWithParseErrors(analysis.statements, diagnostics),
      ),
      diagnostics,
    );
  }

  let candidateDbml: string;
  try {
    candidateDbml = ModelExporter.export(database.normalize(), "dbml", {
      includeRecords: false,
    });
  } catch {
    return failedResult(
      baseReport(input.dialect, filepath, sourceHash, parserInputHash, analysis.statements),
      [
        staticDiagnostic(
          "SQL_PARSE_INTERNAL_CANDIDATE_DBML",
          "SQL schema model could not be exported to candidate DBML.",
        ),
      ],
    );
  }

  const candidateDbmlHash = await sha256Utf8(candidateDbml);
  const candidateParse = await parseDbmlV2(candidateDbml, CANDIDATE_DBML_FILEPATH);
  if (!candidateParse.ok) {
    return failedResult(
      {
        ...baseReport(input.dialect, filepath, sourceHash, parserInputHash, analysis.statements),
        candidateDbmlHash,
      },
      [
        staticDiagnostic(
          "SQL_PARSE_INTERNAL_CANDIDATE_DBML",
          "Generated candidate DBML failed internal validation.",
        ),
      ],
    );
  }

  const semanticVerification = await verifySqlModelToGraph(database, candidateParse.graph);
  if (semanticVerification.status !== "VERIFIED") {
    return failedResult(
      {
        ...baseReport(input.dialect, filepath, sourceHash, parserInputHash, analysis.statements),
        candidateDbmlHash,
        semanticVerification,
      },
      [
        staticDiagnostic(
          "SQL_PARSE_INTERNAL_SEMANTIC_MISMATCH",
          "Candidate DBML does not match the imported SQL schema model.",
        ),
      ],
    );
  }

  const statements = [...analysis.statements];
  const overallStatus = maxStatus(statements.map((statement) => statement.status));
  const containsData = statements.some(
    (statement) => statement.kind === "DML" || statement.kind === "COPY",
  );
  const hasSchemaElements =
    candidateParse.graph.tables.length + candidateParse.graph.enums.length > 0;
  const report: ConversionReport = {
    ...baseReport(input.dialect, filepath, sourceHash, parserInputHash, statements),
    overallStatus,
    applyEligible: !containsData && hasSchemaElements,
    candidateDbmlHash,
    semanticVerification,
  };
  return {
    ok: true,
    report,
    candidate: {
      dbml: candidateDbml,
      dbmlHash: candidateDbmlHash,
      graph: candidateParse.graph,
    },
  };
}

function baseReport(
  dialect: PrimaryDialect,
  sourceFilepath: string,
  sourceHash: string,
  parserInputHash: string,
  statements: readonly SqlStatementConversion[],
): ConversionReport {
  return {
    reportVersion: SQL_CONVERSION_REPORT_VERSION,
    dialect,
    sourceFilepath,
    sourceHash,
    parserInputHash,
    parserVersions: {
      dbmlCore: DBML_PARSER_VERSION,
      dbmlParse: DBML_PARSER_VERSION,
    },
    capabilityMatrixVersion: SQL_CAPABILITY_MATRIX_VERSION,
    schemaSemanticsVersion: SCHEMA_SEMANTICS_VERSION,
    overallStatus:
      statements.length === 0 ? "ERROR" : maxStatus(statements.map(({ status }) => status)),
    applyEligible: false,
    candidateDbmlHash: null,
    statements: [...statements],
    diagnostics: [],
    semanticVerification: notRunVerification(),
  };
}

function failedResult(
  report: ConversionReport,
  diagnostics: Diagnostic[],
): SqlImportConversionResult {
  return {
    ok: false,
    report: {
      ...report,
      overallStatus: "ERROR",
      applyEligible: false,
      diagnostics,
    },
    candidate: null,
  };
}

function parserDiagnostics(
  error: unknown,
  source: string,
  filepath: string,
  dialect: PrimaryDialect,
  tokens: Parameters<typeof rangeAtSqlParserPosition>[2],
): Diagnostic[] {
  const nativeDiagnostics = nativeParserDiagnostics(error);
  const code = `SQL_PARSE_${dialect}_SYNTAX`;
  if (nativeDiagnostics.length === 0) {
    return [staticDiagnostic(code, `${dialectLabel(dialect)} SQL could not be parsed.`)];
  }
  const diagnostics = nativeDiagnostics
    .map((diagnostic) =>
      staticDiagnostic(
        code,
        `${dialectLabel(dialect)} SQL contains invalid syntax.`,
        rangeAtSqlParserPosition(source, filepath, tokens, diagnostic.line, diagnostic.column),
      ),
    )
    .sort(compareDiagnostics);
  return diagnostics.filter(
    (diagnostic, index) =>
      index === 0 || diagnosticIdentity(diagnostic) !== diagnosticIdentity(diagnostics[index - 1]),
  );
}

function nativeParserDiagnostics(error: unknown): Array<{ line: number; column: number }> {
  if (typeof error !== "object" || error === null || !("diags" in error)) return [];
  const diags = (error as { diags?: unknown }).diags;
  if (!Array.isArray(diags)) return [];
  return diags.flatMap((diagnostic) => {
    if (typeof diagnostic !== "object" || diagnostic === null || !("location" in diagnostic)) {
      return [];
    }
    const location = (diagnostic as { location?: unknown }).location;
    if (typeof location !== "object" || location === null || !("start" in location)) return [];
    const start = (location as { start?: unknown }).start;
    if (typeof start !== "object" || start === null) return [];
    const line = (start as { line?: unknown }).line;
    const column = (start as { column?: unknown }).column;
    return typeof line === "number" && typeof column === "number" ? [{ line, column }] : [];
  });
}

function markStatementsWithParseErrors(
  statements: readonly SqlStatementConversion[],
  diagnostics: readonly Diagnostic[],
): SqlStatementConversion[] {
  return statements.map((statement) => {
    const affected = diagnostics.some(
      ({ range }) =>
        range &&
        statement.range.startOffset <= range.startOffset &&
        range.startOffset <= statement.range.endOffset,
    );
    return affected
      ? {
          ...statement,
          status: "ERROR",
          code: diagnostics[0]?.code ?? "SQL_PARSE_INTERNAL_CANDIDATE_DBML",
          message: "This statement contains invalid SQL syntax.",
        }
      : statement;
  });
}

function staticDiagnostic(code: string, message: string, range?: SourceRange): Diagnostic {
  return range ? { code, message, severity: "ERROR", range } : { code, message, severity: "ERROR" };
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    (left.range?.startOffset ?? Number.MAX_SAFE_INTEGER) -
      (right.range?.startOffset ?? Number.MAX_SAFE_INTEGER) ||
    (left.range?.endOffset ?? Number.MAX_SAFE_INTEGER) -
      (right.range?.endOffset ?? Number.MAX_SAFE_INTEGER) ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.message, right.message)
  );
}

function diagnosticIdentity(diagnostic: Diagnostic | undefined): string {
  return JSON.stringify(diagnostic ?? null);
}

function notRunVerification(): SqlSemanticVerification {
  return {
    status: "NOT_RUN",
    sourceModelHash: null,
    candidateSchemaHash: null,
    changes: [],
  };
}

function maxStatus(statuses: readonly ConversionStatus[]): ConversionStatus {
  return statuses.reduce<ConversionStatus>(
    (current, candidate) => (STATUS_RANK[candidate] > STATUS_RANK[current] ? candidate : current),
    "EXACT",
  );
}

function parserFormat(dialect: PrimaryDialect): "postgres" | "mysql" {
  return dialect === "POSTGRESQL" ? "postgres" : "mysql";
}

function dialectLabel(dialect: PrimaryDialect): "PostgreSQL" | "MySQL" {
  return dialect === "POSTGRESQL" ? "PostgreSQL" : "MySQL";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import type { PrimaryDialect, SourceRange } from "@er-diagram/contracts";
import {
  getSqlCapabilityAssessment,
  type ConversionStatus,
  type SqlCapabilityId,
} from "./sql-capabilities.js";
import type {
  SqlClauseConversion,
  SqlStatementConversion,
  SqlStatementKind,
} from "./sql-import.js";

type TokenKind = "WORD" | "QUOTED" | "STRING" | "NUMBER" | "SYMBOL" | "DOLLAR";

interface SqlToken {
  readonly kind: TokenKind;
  readonly text: string;
  readonly upper: string;
  readonly start: number;
  readonly end: number;
}

interface StatementTokens {
  readonly tokens: readonly SqlToken[];
  readonly start: number;
  readonly end: number;
}

interface ClauseDraft {
  readonly capabilityId: SqlCapabilityId | null;
  readonly status: ConversionStatus;
  readonly code: string;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

interface StatementClassification {
  readonly kind: SqlStatementKind;
  readonly capabilityId: SqlCapabilityId | null;
  readonly baseStatus: ConversionStatus;
  readonly code: string;
  readonly message: string;
  readonly clauses: readonly ClauseDraft[];
}

const STATUS_RANK: Readonly<Record<ConversionStatus, number>> = {
  EXACT: 0,
  NORMALIZED: 1,
  PARTIAL: 2,
  UNSUPPORTED: 3,
  ERROR: 4,
};

const BUILTIN_POSTGRESQL_ARRAY_TYPES = new Set([
  "BIGINT",
  "BOOLEAN",
  "BYTEA",
  "CHAR",
  "DATE",
  "DECIMAL",
  "DOUBLE",
  "INTEGER",
  "INT",
  "JSON",
  "JSONB",
  "NUMERIC",
  "REAL",
  "SMALLINT",
  "TEXT",
  "TIME",
  "TIMESTAMP",
  "UUID",
  "VARCHAR",
]);

export interface SqlSourceAnalysis {
  readonly tokens: readonly SqlToken[];
  readonly statements: readonly SqlStatementConversion[];
}

export function analyzeSqlSource(
  source: string,
  filepath: string,
  dialect: PrimaryDialect,
): SqlSourceAnalysis {
  const tokens = tokenizeSql(source, dialect);
  const statements = splitStatements(tokens, source.length).map((statement, statementIndex) =>
    toPublicStatement(
      classifyStatement(statement, dialect),
      statement,
      statementIndex,
      source,
      filepath,
    ),
  );
  return { tokens, statements };
}

export function rangeAtSqlParserPosition(
  source: string,
  filepath: string,
  tokens: readonly SqlToken[],
  line: number,
  zeroBasedColumn: number,
): SourceRange {
  const start = offsetAtNativePosition(source, line, zeroBasedColumn);
  const token = tokens.find((candidate) => candidate.start <= start && start < candidate.end);
  const end = token?.end ?? start;
  return sourceRange(source, filepath, start, end);
}

export function sourceRange(
  source: string,
  filepath: string,
  startOffset: number,
  endOffset: number,
): SourceRange {
  const start = positionAtOffset(source, startOffset);
  const end = positionAtOffset(source, endOffset);
  return {
    filepath,
    startOffset,
    endOffset,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function tokenizeSql(source: string, dialect: PrimaryDialect): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("--", index) || (dialect === "MYSQL" && character === "#")) {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = readBlockComment(source, index);
      continue;
    }

    const dollarDelimiter = dialect === "POSTGRESQL" ? readDollarDelimiter(source, index) : null;
    if (dollarDelimiter) {
      const close = source.indexOf(dollarDelimiter, index + dollarDelimiter.length);
      const end = close < 0 ? source.length : close + dollarDelimiter.length;
      tokens.push(token("DOLLAR", source, index, end));
      index = end;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const kind: TokenKind = character === "'" ? "STRING" : "QUOTED";
      const end = readQuoted(source, index, character);
      tokens.push(token(kind, source, index, end));
      index = end;
      continue;
    }

    if (isWordStart(character)) {
      let end = index + 1;
      while (end < source.length && isWordContinue(source[end] ?? "")) end += 1;
      tokens.push(token("WORD", source, index, end));
      index = end;
      continue;
    }

    if (/[0-9]/u.test(character)) {
      let end = index + 1;
      while (end < source.length && /[0-9A-Fa-f_xX.]/u.test(source[end] ?? "")) end += 1;
      tokens.push(token("NUMBER", source, index, end));
      index = end;
      continue;
    }

    const twoCharacters = source.slice(index, index + 2);
    const symbolLength = ["::", "<=", ">=", "!=", "<>", "||", "->", "=>"].includes(twoCharacters)
      ? 2
      : 1;
    tokens.push(token("SYMBOL", source, index, index + symbolLength));
    index += symbolLength;
  }
  return tokens;
}

function splitStatements(tokens: readonly SqlToken[], sourceLength: number): StatementTokens[] {
  const statements: StatementTokens[] = [];
  let current: SqlToken[] = [];
  let parenthesisDepth = 0;
  let routineBlockDepth = 0;
  let compoundBody = false;

  const flush = (end: number): void => {
    if (current.length === 0) return;
    const first = current[0];
    if (!first) return;
    statements.push({ tokens: current, start: first.start, end });
    current = [];
    parenthesisDepth = 0;
    routineBlockDepth = 0;
    compoundBody = false;
  };

  for (const item of tokens) {
    if (item.text === ";" && parenthesisDepth === 0 && routineBlockDepth === 0) {
      flush(item.end);
      continue;
    }

    current.push(item);
    if (item.text === "(") parenthesisDepth += 1;
    if (item.text === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);

    if (current.length <= 8) compoundBody = looksLikeCompoundBody(current);
    if (compoundBody && parenthesisDepth === 0 && item.upper === "BEGIN") {
      routineBlockDepth += 1;
    }
    if (compoundBody && parenthesisDepth === 0 && item.upper === "END" && routineBlockDepth > 0) {
      routineBlockDepth -= 1;
    }
  }
  flush(current.at(-1)?.end ?? sourceLength);
  return statements;
}

function classifyStatement(
  statement: StatementTokens,
  dialect: PrimaryDialect,
): StatementClassification {
  const tokens = statement.tokens;
  const words = tokens.filter((item) => item.kind === "WORD").map((item) => item.upper);
  const clauses: ClauseDraft[] = [];

  if (startsWithWords(words, ["CREATE", "SCHEMA"])) {
    return classification("CREATE_SCHEMA", null, "EXACT", clauses);
  }
  if (startsWithWords(words, ["CREATE", "TYPE"]) && words.includes("ENUM")) {
    return classification("CREATE_ENUM", "ENUM", statusFor("ENUM", dialect), clauses);
  }
  if (isCreateTable(words)) {
    classifyCreateTableClauses(statement, dialect, clauses);
    return classification(
      "CREATE_TABLE",
      "CREATE_TABLE",
      statusFor("CREATE_TABLE", dialect),
      clauses,
    );
  }
  if (isCreateIndex(words)) {
    classifyCreateIndexClauses(statement, dialect, clauses);
    return classification("CREATE_INDEX", null, "EXACT", clauses);
  }
  if (startsWithWords(words, ["ALTER", "TABLE"])) {
    const foreign = findAlterAddForeignKey(tokens);
    const unique = findAlterAddUnique(tokens);
    if (foreign) {
      addCapability(clauses, "ALTER_ADD_FOREIGN_KEY", foreign, dialect);
      classifyForeignKeyActions(tokens, dialect, clauses);
      classifyCompositeConstraint(tokens, dialect, clauses);
      return classification("ALTER_TABLE", null, "EXACT", clauses);
    }
    if (unique) {
      addCapability(clauses, "ALTER_ADD_UNIQUE", unique, dialect);
      return classification("ALTER_TABLE", null, "EXACT", clauses);
    }
    return classification(
      "ALTER_TABLE",
      "ALTER_COLUMN_MUTATION",
      statusFor("ALTER_COLUMN_MUTATION", dialect),
      clauses,
    );
  }
  if (words[0] === "COMMENT") {
    return classification("COMMENT", "COMMENTS", statusFor("COMMENTS", dialect), clauses);
  }
  if (looksLikeView(words)) {
    return classification("VIEW", "VIEW", statusFor("VIEW", dialect), clauses);
  }
  if (words[0] === "DROP") {
    return classification("DROP", "DROP_STATEMENT", statusFor("DROP_STATEMENT", dialect), clauses);
  }
  if (looksLikeRoutine(tokens)) {
    return classification(
      "ROUTINE",
      "PROCEDURE_OR_FUNCTION_BODY",
      statusFor("PROCEDURE_OR_FUNCTION_BODY", dialect),
      clauses,
    );
  }
  if (words.includes("TRIGGER") && words[0] === "CREATE") {
    return classification("TRIGGER", "TRIGGER", statusFor("TRIGGER", dialect), clauses);
  }
  if (["INSERT", "UPDATE", "DELETE"].includes(words[0] ?? "")) {
    return classification("DML", "DML", statusFor("DML", dialect), clauses);
  }
  if (words[0] === "COPY") {
    return classification("COPY", "COPY_DATA", statusFor("COPY_DATA", dialect), clauses);
  }
  return {
    kind: "UNKNOWN",
    capabilityId: null,
    baseStatus: "UNSUPPORTED",
    code: "SQL_UNSUPPORTED_UNKNOWN_STATEMENT",
    message: "This SQL statement is outside the supported import catalog.",
    clauses,
  };
}

function classifyCreateTableClauses(
  statement: StatementTokens,
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  const tokens = statement.tokens;
  const tableIndex = tokens.findIndex((item) => item.upper === "TABLE");
  const openIndex = tokens.findIndex((item, index) => index > tableIndex && item.text === "(");
  const closeIndex = matchingToken(tokens, openIndex, "(", ")");
  if (tableIndex >= 0 && openIndex > tableIndex) {
    const nameTokens = tokens.slice(tableIndex + 1, openIndex);
    if (nameTokens.some((item) => item.text === ".")) {
      addCapability(clauses, "SCHEMA_QUALIFIED_TABLE", tokenSpan(nameTokens), dialect);
    }
  }

  const bodySegments =
    openIndex >= 0 && closeIndex > openIndex
      ? splitTopLevel(tokens.slice(openIndex + 1, closeIndex), ",")
      : [];
  for (const segment of bodySegments) {
    classifyTableSegment(segment, dialect, clauses);
  }

  if (closeIndex >= 0) {
    const tail = tokens.slice(closeIndex + 1);
    classifyTableTail(tail, dialect, clauses);
  }
}

function classifyTableSegment(
  segment: readonly SqlToken[],
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  if (segment.length === 0) return;
  const upper = segment.map((item) => item.upper);

  for (const sequence of [
    ["PRIMARY", "KEY"],
    ["NOT", "NULL"],
  ] as const) {
    for (const span of findAllWordSequences(segment, sequence)) {
      addCapability(clauses, "BASIC_CONSTRAINTS", span, dialect);
    }
  }
  for (const word of ["UNIQUE", "CHECK", "DEFAULT"] as const) {
    for (const item of segment.filter((candidate) => candidate.upper === word)) {
      addCapability(clauses, "BASIC_CONSTRAINTS", { start: item.start, end: item.end }, dialect);
    }
  }
  const commentIndex = segment.findIndex((item) => item.upper === "COMMENT");
  if (commentIndex >= 0) {
    addCapability(clauses, "COMMENTS", tokenSpan(segment.slice(commentIndex)), dialect);
  }

  const autoIncrement = segment.find((item) => item.upper === "AUTO_INCREMENT");
  if (autoIncrement) addCapability(clauses, "AUTO_INCREMENT", spanOf(autoIncrement), dialect);

  const serial = segment.find((item) => item.upper === "SERIAL" || item.upper === "BIGSERIAL");
  if (serial) addCapability(clauses, "SERIAL", spanOf(serial), dialect);

  const generatedIndex = upper.indexOf("GENERATED");
  const identityIndex = upper.indexOf("IDENTITY");
  if (generatedIndex >= 0 && identityIndex > generatedIndex) {
    const endIndex = firstConstraintIndexAfter(segment, identityIndex + 1);
    addCapability(
      clauses,
      "IDENTITY",
      tokenSpan(segment.slice(generatedIndex, endIndex < 0 ? segment.length : endIndex)),
      dialect,
    );
  } else if (generatedIndex >= 0) {
    addCapability(clauses, "GENERATED_COLUMN", tokenSpan(segment.slice(generatedIndex)), dialect);
  }

  const enumIndex = segment.findIndex((item) => item.upper === "ENUM");
  if (enumIndex >= 0) {
    const end = matchingToken(segment, enumIndex + 1, "(", ")");
    addCapability(
      clauses,
      "ENUM",
      tokenSpan(segment.slice(enumIndex, end >= 0 ? end + 1 : enumIndex + 1)),
      dialect,
    );
  }

  classifyArrayType(segment, dialect, clauses);
  classifyForeignKeyActions(segment, dialect, clauses);
  classifyCompositeConstraint(segment, dialect, clauses);

  const indexStart = segment.findIndex((item) => ["INDEX", "KEY"].includes(item.upper));
  const uniqueKey = findWordSequence(segment, ["UNIQUE", "KEY"]);
  if (dialect === "MYSQL" && (indexStart >= 0 || uniqueKey)) {
    addCapability(clauses, "MYSQL_INDEXES", tokenSpan(segment), dialect);
    classifyFunctionIndex(segment, dialect, clauses);
  }
}

function classifyTableTail(
  tail: readonly SqlToken[],
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  if (tail.length === 0) return;
  const tablespace = tail.findIndex((item) => item.upper === "TABLESPACE");
  if (tablespace >= 0) {
    addCapability(
      clauses,
      "TABLESPACE",
      tokenSpan(tail.slice(tablespace, Math.min(tail.length, tablespace + 2))),
      dialect,
    );
  }
  const optionIndex = tail.findIndex((item) =>
    ["ENGINE", "CHARSET", "COLLATE"].includes(item.upper),
  );
  if (optionIndex >= 0) {
    addCapability(clauses, "MYSQL_TABLE_OPTIONS", tokenSpan(tail.slice(optionIndex)), dialect);
  }
  const commentIndex = tail.findIndex((item) => item.upper === "COMMENT");
  if (commentIndex >= 0) {
    const commentEnd = Math.min(tail.length, commentIndex + 3);
    addCapability(clauses, "COMMENTS", tokenSpan(tail.slice(commentIndex, commentEnd)), dialect);
  }

  const recognized = new Set<number>();
  if (tablespace >= 0) {
    recognized.add(tablespace);
    recognized.add(tablespace + 1);
  }
  if (optionIndex >= 0) {
    for (let index = optionIndex; index < tail.length; index += 1) recognized.add(index);
  }
  if (commentIndex >= 0) {
    for (let index = commentIndex; index < Math.min(tail.length, commentIndex + 3); index += 1) {
      recognized.add(index);
    }
  }
  const unknown = tail.filter((item, index) => !recognized.has(index) && item.text !== ";");
  if (unknown.length > 0) {
    clauses.push({
      capabilityId: null,
      status: "UNSUPPORTED",
      code: "SQL_UNSUPPORTED_UNKNOWN_CLAUSE",
      message: "This table clause is outside the supported import catalog.",
      ...tokenSpan(unknown),
    });
  }
}

function classifyCreateIndexClauses(
  statement: StatementTokens,
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  const tokens = statement.tokens;
  classifyFunctionIndex(tokens, dialect, clauses);
  const usingIndex = tokens.findIndex((item) => item.upper === "USING");
  if (usingIndex >= 0 && tokens[usingIndex + 1]) {
    addCapability(
      clauses,
      "INDEX_METHODS",
      tokenSpan(tokens.slice(usingIndex, usingIndex + 2)),
      dialect,
    );
  }
  const whereIndex = tokens.findIndex((item) => item.upper === "WHERE");
  if (whereIndex >= 0) {
    addCapability(clauses, "PARTIAL_INDEX", tokenSpan(tokens.slice(whereIndex)), dialect);
  }
  const onIndex = tokens.findIndex((item) => item.upper === "ON");
  const outerOpen = tokens.findIndex((item, index) => index > onIndex && item.text === "(");
  const outerClose = matchingToken(tokens, outerOpen, "(", ")");
  if (outerClose >= 0) {
    const tailEnd = whereIndex >= 0 ? whereIndex : tokens.length;
    const tail = tokens.slice(outerClose + 1, tailEnd);
    const tablespaceIndex = tail.findIndex((item) => item.upper === "TABLESPACE");
    if (tablespaceIndex >= 0) {
      addCapability(
        clauses,
        "TABLESPACE",
        tokenSpan(tail.slice(tablespaceIndex, tablespaceIndex + 2)),
        dialect,
      );
    }
    const unknown = tail.filter(
      (_, index) => index !== tablespaceIndex && index !== tablespaceIndex + 1,
    );
    if (unknown.length > 0) addUnknownClause(clauses, unknown, "index");
  }
  classifyCompositeConstraint(tokens, dialect, clauses);
}

function classifyFunctionIndex(
  tokens: readonly SqlToken[],
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  const onIndex = tokens.findIndex((item) => item.upper === "ON");
  const outerOpen = tokens.findIndex((item, index) => index > onIndex && item.text === "(");
  const outerClose = matchingToken(tokens, outerOpen, "(", ")");
  if (outerOpen < 0 || outerClose < 0) return;
  const terms = tokens.slice(outerOpen + 1, outerClose);
  for (let index = 0; index < terms.length - 1; index += 1) {
    const current = terms[index];
    const next = terms[index + 1];
    if (!current || !next || current.kind !== "WORD" || next.text !== "(") continue;
    const close = matchingToken(terms, index + 1, "(", ")");
    if (close > index + 1) {
      addCapability(clauses, "FUNCTION_INDEX", tokenSpan(terms.slice(index, close + 1)), dialect);
      return;
    }
  }
}

function classifyArrayType(
  segment: readonly SqlToken[],
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  for (let index = 0; index < segment.length - 1; index += 1) {
    if (segment[index]?.text !== "[" || segment[index + 1]?.text !== "]") continue;
    let start = index - 1;
    while (start >= 2 && segment[start - 1]?.text === ".") start -= 2;
    const typeTokens = segment.slice(start, index + 2);
    const hasSchema = typeTokens.some((item) => item.text === ".");
    const typeWord = typeTokens.find((item) => item.kind === "WORD")?.upper ?? "";
    const capability: SqlCapabilityId =
      hasSchema && !BUILTIN_POSTGRESQL_ARRAY_TYPES.has(typeWord)
        ? "ARRAY_SCHEMA_ENUM"
        : "ARRAY_BUILTIN";
    addCapability(clauses, capability, tokenSpan(typeTokens), dialect);
    break;
  }
}

function classifyForeignKeyActions(
  tokens: readonly SqlToken[],
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  const onIndex = tokens.findIndex(
    (item, index) =>
      item.upper === "ON" && ["DELETE", "UPDATE"].includes(tokens[index + 1]?.upper ?? ""),
  );
  if (onIndex >= 0) {
    addCapability(clauses, "FOREIGN_KEY_ACTIONS", tokenSpan(tokens.slice(onIndex)), dialect);
  }
}

function classifyCompositeConstraint(
  tokens: readonly SqlToken[],
  dialect: PrimaryDialect,
  clauses: ClauseDraft[],
): void {
  for (let open = 0; open < tokens.length; open += 1) {
    if (tokens[open]?.text !== "(") continue;
    const close = matchingToken(tokens, open, "(", ")");
    if (close < 0) continue;
    const inside = tokens.slice(open + 1, close);
    if (inside.some((item) => item.text === ",")) {
      addCapability(
        clauses,
        "COMPOSITE_KEYS",
        tokenSpan(tokens.slice(Math.max(0, open - 2), close + 1)),
        dialect,
      );
      return;
    }
    open = close;
  }
}

function findAlterAddUnique(tokens: readonly SqlToken[]): { start: number; end: number } | null {
  const addIndex = tokens.findIndex((item) => item.upper === "ADD");
  if (addIndex < 0) return null;
  const uniqueIndex = tokens.findIndex(
    (item, index) => index > addIndex && item.upper === "UNIQUE",
  );
  return uniqueIndex < 0 ? null : tokenSpan(tokens.slice(addIndex));
}

function findAlterAddForeignKey(
  tokens: readonly SqlToken[],
): { start: number; end: number } | null {
  const addIndex = tokens.findIndex((item) => item.upper === "ADD");
  if (addIndex < 0) return null;
  const foreignIndex = tokens.findIndex(
    (item, index) =>
      index > addIndex && item.upper === "FOREIGN" && tokens[index + 1]?.upper === "KEY",
  );
  return foreignIndex < 0 ? null : tokenSpan(tokens.slice(addIndex));
}

function toPublicStatement(
  classificationValue: StatementClassification,
  statement: StatementTokens,
  statementIndex: number,
  source: string,
  filepath: string,
): SqlStatementConversion {
  const clauses = [...classificationValue.clauses].sort(compareClauseDrafts).map(
    (clause, clauseIndex): SqlClauseConversion => ({
      clauseNo: clauseIndex + 1,
      capabilityId: clause.capabilityId,
      status: clause.status,
      code: clause.code,
      message: clause.message,
      range: sourceRange(source, filepath, clause.start, clause.end),
    }),
  );
  const status = maxStatus([
    classificationValue.baseStatus,
    ...clauses.map((clause) => clause.status),
  ]);
  return {
    statementNo: statementIndex + 1,
    kind: classificationValue.kind,
    capabilityId: classificationValue.capabilityId,
    status,
    code:
      status === classificationValue.baseStatus
        ? classificationValue.code
        : `SQL_${status}_STATEMENT`,
    message:
      status === classificationValue.baseStatus
        ? classificationValue.message
        : `This statement has ${status.toLowerCase()} conversion details.`,
    range: sourceRange(source, filepath, statement.start, statement.end),
    clauses,
  };
}

function classification(
  kind: SqlStatementKind,
  capabilityId: SqlCapabilityId | null,
  baseStatus: ConversionStatus,
  clauses: readonly ClauseDraft[],
): StatementClassification {
  return {
    kind,
    capabilityId,
    baseStatus,
    code:
      capabilityId === "DML" || capabilityId === "COPY_DATA"
        ? "SQL_UNSUPPORTED_DATA_STATEMENT"
        : capabilityId
          ? statusCode(baseStatus, capabilityId)
          : `SQL_${baseStatus}_STATEMENT`,
    message:
      capabilityId === "DML" || capabilityId === "COPY_DATA"
        ? "Data statements are excluded from schema import."
        : capabilityId
          ? capabilityMessage(capabilityId, baseStatus)
          : `This statement converts with ${baseStatus.toLowerCase()} status.`,
    clauses,
  };
}

function addCapability(
  clauses: ClauseDraft[],
  capabilityId: SqlCapabilityId,
  range: { start: number; end: number } | null,
  dialect: PrimaryDialect,
): void {
  if (!range || range.end <= range.start) return;
  const status = statusFor(capabilityId, dialect);
  if (
    clauses.some(
      (item) =>
        item.capabilityId === capabilityId && item.start === range.start && item.end === range.end,
    )
  ) {
    return;
  }
  clauses.push({
    capabilityId,
    status,
    code:
      capabilityId === "DML" || capabilityId === "COPY_DATA"
        ? "SQL_UNSUPPORTED_DATA_STATEMENT"
        : statusCode(status, capabilityId),
    message: capabilityMessage(capabilityId, status),
    ...range,
  });
}

function addUnknownClause(
  clauses: ClauseDraft[],
  tokens: readonly SqlToken[],
  owner: "index" | "table",
): void {
  if (tokens.length === 0) return;
  clauses.push({
    capabilityId: null,
    status: "UNSUPPORTED",
    code: "SQL_UNSUPPORTED_UNKNOWN_CLAUSE",
    message: `This ${owner} clause is outside the supported import catalog.`,
    ...tokenSpan(tokens),
  });
}

function statusFor(capabilityId: SqlCapabilityId, dialect: PrimaryDialect): ConversionStatus {
  const status = getSqlCapabilityAssessment(capabilityId, dialect).observedStatus;
  return status === "NOT_APPLICABLE" ? "UNSUPPORTED" : status;
}

function statusCode(status: ConversionStatus, capabilityId: SqlCapabilityId): string {
  return `SQL_${status}_${capabilityId}`;
}

function capabilityMessage(capabilityId: SqlCapabilityId, status: ConversionStatus): string {
  const descriptions: Readonly<Partial<Record<SqlCapabilityId, string>>> = {
    ALTER_COLUMN_MUTATION: "ALTER TABLE column mutations are not imported.",
    COPY_DATA: "COPY data is excluded from schema import.",
    DML: "Data statements are excluded from schema import.",
    DROP_STATEMENT: "DROP statements are not applied by schema import.",
    GENERATED_COLUMN: "The generated expression is not preserved in DBML.",
    IDENTITY: "PostgreSQL identity options are only partially preserved.",
    MYSQL_TABLE_OPTIONS: "MySQL table options are not preserved in DBML.",
    PARTIAL_INDEX: "The partial-index predicate is not preserved in DBML.",
    PROCEDURE_OR_FUNCTION_BODY: "Routine bodies are outside schema import.",
    TABLESPACE: "The tablespace clause is not preserved in DBML.",
    TRIGGER: "Triggers are outside schema import.",
    VIEW: "SQL views are outside schema import.",
  };
  return (
    descriptions[capabilityId] ?? `This capability converts with ${status.toLowerCase()} status.`
  );
}

function maxStatus(statuses: readonly ConversionStatus[]): ConversionStatus {
  return statuses.reduce((current, candidate) =>
    STATUS_RANK[candidate] > STATUS_RANK[current] ? candidate : current,
  );
}

function compareClauseDrafts(left: ClauseDraft, right: ClauseDraft): number {
  return (
    left.start - right.start ||
    left.end - right.end ||
    compareCodeUnits(left.capabilityId ?? "", right.capabilityId ?? "")
  );
}

function token(kind: TokenKind, source: string, start: number, end: number): SqlToken {
  const text = source.slice(start, end);
  return { kind, text, upper: kind === "WORD" ? text.toUpperCase() : text, start, end };
}

function readQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === quote) {
      if (source[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    // The dialect parser remains authoritative. Conservatively treating a backslash as an
    // escape prevents semicolons after escaped quote characters from becoming false delimiters.
    if (source[index] === "\\") index += 1;
    index += 1;
  }
  return source.length;
}

function readDollarDelimiter(source: string, start: number): string | null {
  if (source[start] !== "$") return null;
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(source.slice(start));
  return match?.[0] ?? null;
}

function readBlockComment(source: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < source.length && depth > 0) {
    if (source.startsWith("/*", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (source.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function isWordStart(character: string): boolean {
  return /[A-Za-z_\u0080-\uFFFF]/u.test(character);
}

function isWordContinue(character: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(character);
}

function looksLikeRoutine(tokens: readonly SqlToken[]): boolean {
  const words = tokens.filter((item) => item.kind === "WORD").map((item) => item.upper);
  if (words[0] !== "CREATE") return false;
  if (words[1] === "FUNCTION" || words[1] === "PROCEDURE") return true;
  return (
    words[1] === "OR" &&
    words[2] === "REPLACE" &&
    (words[3] === "FUNCTION" || words[3] === "PROCEDURE")
  );
}

function looksLikeCompoundBody(tokens: readonly SqlToken[]): boolean {
  if (looksLikeRoutine(tokens)) return true;
  const words = tokens.filter((item) => item.kind === "WORD").map((item) => item.upper);
  return words[0] === "CREATE" && words[1] === "TRIGGER";
}

function isCreateTable(words: readonly string[]): boolean {
  return (
    words[0] === "CREATE" &&
    ["TABLE", "TEMP", "TEMPORARY"].some((word) => words[1] === word || words[2] === word)
  );
}

function isCreateIndex(words: readonly string[]): boolean {
  return (
    words[0] === "CREATE" &&
    (words[1] === "INDEX" || (words[1] === "UNIQUE" && words[2] === "INDEX"))
  );
}

function looksLikeView(words: readonly string[]): boolean {
  return words[0] === "CREATE" && words.slice(1, 5).includes("VIEW");
}

function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, index) => words[index] === word);
}

function findWordSequence(
  tokens: readonly SqlToken[],
  words: readonly string[],
): { start: number; end: number } | null {
  for (let index = 0; index <= tokens.length - words.length; index += 1) {
    if (words.every((word, offset) => tokens[index + offset]?.upper === word)) {
      return tokenSpan(tokens.slice(index, index + words.length));
    }
  }
  return null;
}

function findAllWordSequences(
  tokens: readonly SqlToken[],
  words: readonly string[],
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  for (let index = 0; index <= tokens.length - words.length; index += 1) {
    if (words.every((word, offset) => tokens[index + offset]?.upper === word)) {
      const span = tokenSpan(tokens.slice(index, index + words.length));
      if (span) matches.push(span);
    }
  }
  return matches;
}

function tokenSpan(tokens: readonly SqlToken[]): { start: number; end: number } {
  const first = tokens[0];
  const last = tokens.at(-1);
  if (!first || !last) return { start: 0, end: 0 };
  return { start: first.start, end: last.end };
}

function spanOf(value: SqlToken): { start: number; end: number } {
  return { start: value.start, end: value.end };
}

function matchingToken(
  tokens: readonly SqlToken[],
  openIndex: number,
  open: string,
  close: string,
): number {
  if (openIndex < 0 || tokens[openIndex]?.text !== open) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.text === open) depth += 1;
    if (tokens[index]?.text === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(tokens: readonly SqlToken[], delimiter: string): SqlToken[][] {
  const groups: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (const item of tokens) {
    if (item.text === "(") depth += 1;
    if (item.text === ")") depth = Math.max(0, depth - 1);
    if (item.text === delimiter && depth === 0) {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(item);
  }
  groups.push(current);
  return groups;
}

function firstConstraintIndexAfter(tokens: readonly SqlToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (item?.text === "(") depth += 1;
    if (item?.text === ")") depth = Math.max(0, depth - 1);
    if (
      depth === 0 &&
      ["PRIMARY", "UNIQUE", "NOT", "DEFAULT", "CHECK", "REFERENCES", "COMMENT"].includes(
        item?.upper ?? "",
      )
    ) {
      return index;
    }
  }
  return -1;
}

function offsetAtNativePosition(source: string, line: number, zeroBasedColumn: number): number {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(zeroBasedColumn)) {
    return source.length;
  }
  let lineStart = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) return source.length;
    lineStart = newline + 1;
  }
  const newline = source.indexOf("\n", lineStart);
  const lineEnd = newline < 0 ? source.length : newline;
  return Math.min(lineEnd, Math.max(lineStart, lineStart + Math.max(0, zeroBasedColumn)));
}

function positionAtOffset(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.min(source.length, Math.max(0, offset));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

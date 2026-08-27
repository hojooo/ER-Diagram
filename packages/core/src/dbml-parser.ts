import { Parser } from "@dbml/core";
import type { Diagnostic } from "@er-diagram/contracts";
import { sha256Utf8 } from "./hash.js";
import { normalizeSchemaGraph, SchemaGraphNormalizationError } from "./normalize-schema-graph.js";
import type { SchemaGraph } from "./schema-graph.js";
import {
  buildProjectSourceTextIndex,
  buildSingleFileSourceTextIndex,
} from "./source-text-index.js";

export const DBML_PARSE_MODE = "dbmlv2" as const;
const DEFAULT_FILEPATH = "/main.dbml";

export interface DbmlParseSuccess {
  ok: true;
  sourceHash: string;
  parserInputHash: string;
  graph: SchemaGraph;
}

export interface DbmlParseFailure {
  ok: false;
  sourceHash: string;
  parserInputHash: string;
  diagnostics: Diagnostic[];
}

export type DbmlParseResult = DbmlParseSuccess | DbmlParseFailure;

export interface DbmlProjectParseSuccess {
  ok: true;
  sourceHashes: Record<string, string>;
  parserInputHashes: Record<string, string>;
  graph: SchemaGraph;
}

export interface DbmlProjectParseFailure {
  ok: false;
  sourceHashes: Record<string, string>;
  parserInputHashes: Record<string, string>;
  diagnostics: Diagnostic[];
}

export type DbmlProjectParseResult = DbmlProjectParseSuccess | DbmlProjectParseFailure;

interface CompilerDiagnosticLike {
  code?: string | number;
  message?: string;
  location?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
}

interface CompilerFailureLike {
  diags?: CompilerDiagnosticLike[];
  message?: string;
}

export async function parseDbmlV2(
  source: string,
  filepath = DEFAULT_FILEPATH,
): Promise<DbmlParseResult> {
  const sourceHash = await sha256Utf8(source);
  const parserInput = source;
  const parserInputHash = await sha256Utf8(parserInput);

  try {
    const database = Parser.parse(parserInput, DBML_PARSE_MODE);
    return {
      ok: true,
      sourceHash,
      parserInputHash,
      graph: await normalizeSchemaGraph(database, {
        fallbackFilepath: filepath,
        forceFilepath: true,
        sourceText: buildSingleFileSourceTextIndex(parserInput, filepath),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      sourceHash,
      parserInputHash,
      diagnostics: normalizeDiagnostics(error, source),
    };
  }
}

export async function parseDbmlProjectV2(input: {
  entrypoint: string;
  files: Record<string, string>;
}): Promise<DbmlProjectParseResult> {
  const sourceHashes = await hashSources(input.files);
  const parser = new Parser();
  const parserInputHashes: Record<string, string> = {};

  for (const [filepath, source] of Object.entries(input.files)) {
    const parserInput = source;
    parser.setDbmlSource(filepath, parserInput);
    parserInputHashes[filepath] = await sha256Utf8(parserInput);
  }

  if (!(input.entrypoint in input.files)) {
    return {
      ok: false,
      sourceHashes,
      parserInputHashes,
      diagnostics: [
        {
          code: "DBML_ENTRYPOINT_NOT_FOUND",
          message: `DBML entrypoint was not provided: ${input.entrypoint}`,
          severity: "ERROR",
        },
      ],
    };
  }

  try {
    const database = parser.parseDbmlProject(input.entrypoint);
    return {
      ok: true,
      sourceHashes,
      parserInputHashes,
      graph: await normalizeSchemaGraph(database, {
        fallbackFilepath: input.entrypoint,
        forceFilepath: false,
        sourceText: buildProjectSourceTextIndex(parser.DBMLCompiler, Object.keys(input.files)),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      sourceHashes,
      parserInputHashes,
      diagnostics: normalizeDiagnostics(error, input.files[input.entrypoint] ?? ""),
    };
  }
}

async function hashSources(files: Record<string, string>): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [filepath, source] of Object.entries(files)) {
    hashes[filepath] = await sha256Utf8(source);
  }
  return hashes;
}

function normalizeDiagnostics(error: unknown, source: string): Diagnostic[] {
  if (error instanceof SchemaGraphNormalizationError) {
    return [
      {
        code: "DBML_NORMALIZATION_ERROR",
        message: error.message,
        severity: "ERROR",
      },
    ];
  }
  const failure = error as CompilerFailureLike;
  if (!Array.isArray(failure?.diags) || failure.diags.length === 0) {
    return [
      {
        code: "DBML_PARSE_ERROR",
        message: failure?.message || "DBML parsing failed.",
        severity: "ERROR",
      },
    ];
  }

  return failure.diags.map((diagnostic) => {
    const startLine = diagnostic.location?.start?.line ?? 1;
    const startColumn = diagnostic.location?.start?.column ?? 1;
    const endLine = diagnostic.location?.end?.line ?? startLine;
    const endColumn = diagnostic.location?.end?.column ?? startColumn;
    return {
      code: `DBML_${diagnostic.code ?? "PARSE_ERROR"}`,
      message: diagnostic.message ?? "DBML parsing failed.",
      severity: "ERROR" as const,
      range: {
        startOffset: offsetAt(source, startLine, startColumn),
        endOffset: offsetAt(source, endLine, endColumn),
        startLine,
        startColumn,
        endLine,
        endColumn,
      },
    };
  });
}

function offsetAt(source: string, line: number, column: number): number {
  if (line <= 1) return Math.min(source.length, Math.max(0, column - 1));
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < source.length) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) return source.length;
    offset = newline + 1;
    currentLine += 1;
  }
  return Math.min(source.length, offset + Math.max(0, column - 1));
}

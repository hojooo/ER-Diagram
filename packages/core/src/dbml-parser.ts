import { Parser } from "@dbml/core";
import { Filepath } from "@dbml/parse";
import { diagnosticSchema, type Diagnostic } from "@er-diagram/contracts";
import { normalizeDbmlDiagnostics } from "./dbml-diagnostics.js";
import type { DbmlSourceContext } from "./dbml-source-range.js";
import { sha256Utf8 } from "./hash.js";
import { normalizeSchemaGraph, SchemaGraphNormalizationError } from "./normalize-schema-graph.js";
import type { SchemaGraph } from "./schema-graph.js";
import { buildCompilerSourceTextIndex } from "./source-text-index.js";

export const DBML_PARSE_MODE = "dbmlv2" as const;
const DEFAULT_FILEPATH = "/main.dbml";
const SINGLE_FILE_COMPILER_PATH = Filepath.from(DEFAULT_FILEPATH);

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

interface RegisteredSourceFile {
  publicFilepath: string;
  compilerFilepath: Filepath;
  source: string;
}

type CompilationResult =
  | { ok: true; graph: SchemaGraph }
  | { ok: false; diagnostics: Diagnostic[] };

export async function parseDbmlV2(
  source: string,
  filepath = DEFAULT_FILEPATH,
): Promise<DbmlParseResult> {
  const sourceHash = await sha256Utf8(source);
  const parserInputHash = sourceHash;
  if (filepath.length === 0) {
    return {
      ok: false,
      sourceHash,
      parserInputHash,
      diagnostics: [
        errorDiagnostic("DBML_PARSE_INTERNAL_FILEPATH", "DBML source filepath must not be empty."),
      ],
    };
  }

  const parser = new Parser();
  const file: RegisteredSourceFile = {
    publicFilepath: filepath,
    compilerFilepath: SINGLE_FILE_COMPILER_PATH,
    source,
  };
  parser.setDbmlSource(file.compilerFilepath, source);
  const compiled = await compileDbml(parser, file, [file]);

  return compiled.ok
    ? { ok: true, sourceHash, parserInputHash, graph: compiled.graph }
    : { ok: false, sourceHash, parserInputHash, diagnostics: compiled.diagnostics };
}

export async function parseDbmlProjectV2(input: {
  entrypoint: string;
  files: Record<string, string>;
}): Promise<DbmlProjectParseResult> {
  const sourceHashes = await hashSources(input.files);
  const parserInputHashes = { ...sourceHashes };

  if (!(input.entrypoint in input.files)) {
    return {
      ok: false,
      sourceHashes,
      parserInputHashes,
      diagnostics: [
        errorDiagnostic(
          "DBML_SEMANTIC_ENTRYPOINT_NOT_FOUND",
          `DBML entrypoint was not provided: ${input.entrypoint}`,
        ),
      ],
    };
  }

  const registered = registerProjectFiles(input.files);
  if (!registered.ok) {
    return {
      ok: false,
      sourceHashes,
      parserInputHashes,
      diagnostics: [registered.diagnostic],
    };
  }

  const entrypoint = registered.files.find((file) => file.publicFilepath === input.entrypoint);
  if (!entrypoint) {
    return {
      ok: false,
      sourceHashes,
      parserInputHashes,
      diagnostics: [
        errorDiagnostic(
          "DBML_PARSE_INTERNAL_FILEPATH",
          "DBML entrypoint filepath could not be registered.",
        ),
      ],
    };
  }

  const parser = new Parser();
  for (const file of registered.files) {
    parser.setDbmlSource(file.compilerFilepath, file.source);
  }
  const compiled = await compileDbml(parser, entrypoint, registered.files);

  return compiled.ok
    ? { ok: true, sourceHashes, parserInputHashes, graph: compiled.graph }
    : { ok: false, sourceHashes, parserInputHashes, diagnostics: compiled.diagnostics };
}

async function compileDbml(
  parser: Parser,
  entrypoint: RegisteredSourceFile,
  files: readonly RegisteredSourceFile[],
): Promise<CompilationResult> {
  const context = sourceContext(entrypoint.publicFilepath, files);
  let report: ReturnType<Parser["DBMLCompiler"]["interpretFile"]>;
  try {
    report = parser.DBMLCompiler.interpretFile(entrypoint.compilerFilepath);
  } catch {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          "DBML_PARSE_INTERNAL_COMPILER_FAILURE",
          "DBML compiler failed unexpectedly.",
        ),
      ],
    };
  }

  const diagnostics = normalizeDbmlDiagnostics(
    {
      errors: report.getErrors(),
      warnings: report.getWarnings(),
      infos: report.getInfos(),
    },
    context,
  );
  if (diagnostics.some((diagnostic) => diagnostic.severity === "ERROR")) {
    return { ok: false, diagnostics };
  }

  const rawDatabase = report.getValue();
  if (!rawDatabase) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          "DBML_PARSE_INTERNAL_COMPILER_VALUE",
          "DBML compiler did not return a database.",
        ),
      ],
    };
  }

  try {
    const database = Parser.parseJSONToDatabase(
      rawDatabase as unknown as Parameters<typeof Parser.parseJSONToDatabase>[0],
    );
    const graph = await normalizeSchemaGraph(database, {
      fallbackFilepath: entrypoint.publicFilepath,
      forceFilepath: false,
      publicFilepathByCompilerPath: context.publicFilepathByCompilerPath,
      sourceByPublicFilepath: context.sourceByPublicFilepath,
      sourceText: buildCompilerSourceTextIndex(parser.DBMLCompiler, files),
    });
    return { ok: true, graph: { ...graph, diagnostics } };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        error instanceof SchemaGraphNormalizationError
          ? errorDiagnostic(
              "DBML_PARSE_INTERNAL_NORMALIZATION_FAILURE",
              "DBML was compiled but could not be normalized.",
            )
          : errorDiagnostic(
              "DBML_PARSE_INTERNAL_COMPILER_VALUE",
              "DBML compiler returned an invalid database.",
            ),
      ],
    };
  }
}

function registerProjectFiles(
  sources: Record<string, string>,
): { ok: true; files: RegisteredSourceFile[] } | { ok: false; diagnostic: Diagnostic } {
  const files: RegisteredSourceFile[] = [];
  const publicFilepathByCompilerPath = new Map<string, string>();

  for (const [publicFilepath, source] of Object.entries(sources)) {
    const compilerFilepath = compilerFilepathFromPublic(publicFilepath);
    if (!compilerFilepath) {
      return {
        ok: false,
        diagnostic: errorDiagnostic(
          "DBML_PARSE_INTERNAL_FILEPATH",
          `DBML filepath could not be canonicalized: ${publicFilepath || "<empty>"}`,
        ),
      };
    }

    const existing = publicFilepathByCompilerPath.get(compilerFilepath.absolute);
    if (existing !== undefined) {
      return {
        ok: false,
        diagnostic: errorDiagnostic(
          "DBML_SEMANTIC_FILEPATH_COLLISION",
          `DBML filepaths resolve to the same compiler path: ${existing}, ${publicFilepath}`,
        ),
      };
    }

    publicFilepathByCompilerPath.set(compilerFilepath.absolute, publicFilepath);
    files.push({ publicFilepath, compilerFilepath, source });
  }

  return { ok: true, files };
}

function compilerFilepathFromPublic(filepath: string): Filepath | null {
  if (filepath.length === 0) return null;
  try {
    return Filepath.from(filepath.startsWith("/") ? filepath : `/${filepath}`);
  } catch {
    return null;
  }
}

function sourceContext(
  fallbackPublicFilepath: string,
  files: readonly RegisteredSourceFile[],
): Required<DbmlSourceContext> {
  return {
    fallbackPublicFilepath,
    publicFilepathByCompilerPath: new Map(
      files.map((file) => [file.compilerFilepath.absolute, file.publicFilepath]),
    ),
    sourceByPublicFilepath: new Map(files.map((file) => [file.publicFilepath, file.source])),
  };
}

async function hashSources(files: Record<string, string>): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [filepath, source] of Object.entries(files)) {
    hashes[filepath] = await sha256Utf8(source);
  }
  return hashes;
}

function errorDiagnostic(code: string, message: string): Diagnostic {
  return diagnosticSchema.parse({ code, message, severity: "ERROR" });
}

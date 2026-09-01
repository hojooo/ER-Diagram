import { Compiler, Filepath, MemoryProjectLayout } from "@dbml/parse";
import { diagnosticSchema, type Diagnostic } from "@er-diagram/contracts";
import { normalizeDbmlDiagnostics } from "./dbml-diagnostics.js";
import type { DbmlSourceContext } from "./dbml-source-range.js";
import { sha256Utf8 } from "./hash.js";
import {
  normalizeCompilerSchemaGraph,
  SchemaGraphNormalizationError,
} from "./normalize-schema-graph.js";
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

export interface RegisteredSourceFile {
  publicFilepath: string;
  compilerFilepath: Filepath;
  source: string;
}

type GraphCompilationResult =
  | { ok: true; graph: SchemaGraph }
  | { ok: false; diagnostics: Diagnostic[] };

export type DbmlInterpretationResult =
  | {
      ok: true;
      rawDatabase: unknown;
      diagnostics: Diagnostic[];
      sourceContext: Required<DbmlSourceContext>;
      sourceText: ReturnType<typeof buildCompilerSourceTextIndex>;
    }
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

  const file: RegisteredSourceFile = {
    publicFilepath: filepath,
    compilerFilepath: SINGLE_FILE_COMPILER_PATH,
    source,
  };
  const result = await compileDbmlGraph(createCompiler([file]), file, [file]);
  return result.ok
    ? {
        ok: true,
        sourceHash,
        parserInputHash,
        graph: result.graph,
      }
    : { ok: false, sourceHash, parserInputHash, diagnostics: result.diagnostics };
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

  const compiled = await compileDbmlGraph(
    createCompiler(registered.files),
    entrypoint,
    registered.files,
  );

  return compiled.ok
    ? { ok: true, sourceHashes, parserInputHashes, graph: compiled.graph }
    : { ok: false, sourceHashes, parserInputHashes, diagnostics: compiled.diagnostics };
}

async function compileDbmlGraph(
  compiler: Compiler,
  entrypoint: RegisteredSourceFile,
  files: readonly RegisteredSourceFile[],
): Promise<GraphCompilationResult> {
  const interpreted = interpretDbml(compiler, entrypoint, files);
  if (!interpreted.ok) return interpreted;

  try {
    const graph = await normalizeCompilerSchemaGraph(interpreted.rawDatabase, {
      fallbackFilepath: entrypoint.publicFilepath,
      forceFilepath: false,
      publicFilepathByCompilerPath: interpreted.sourceContext.publicFilepathByCompilerPath,
      sourceByPublicFilepath: interpreted.sourceContext.sourceByPublicFilepath,
      sourceText: interpreted.sourceText,
    });
    return { ok: true, graph: { ...graph, diagnostics: interpreted.diagnostics } };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        error instanceof SchemaGraphNormalizationError || error instanceof TypeError
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

export function interpretDbml(
  compiler: Compiler,
  entrypoint: RegisteredSourceFile,
  files: readonly RegisteredSourceFile[],
): DbmlInterpretationResult {
  const context = sourceContext(entrypoint.publicFilepath, files);
  let report: ReturnType<Compiler["interpretFile"]>;
  try {
    report = compiler.interpretFile(entrypoint.compilerFilepath);
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
    return {
      ok: true,
      rawDatabase,
      diagnostics,
      sourceContext: context,
      sourceText: buildCompilerSourceTextIndex(compiler, files),
    };
  } catch {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          "DBML_PARSE_INTERNAL_COMPILER_VALUE",
          "DBML compiler returned an invalid source index.",
        ),
      ],
    };
  }
}

function createCompiler(files: readonly RegisteredSourceFile[]): Compiler {
  const layout = new MemoryProjectLayout();
  for (const file of files) layout.setSource(file.compilerFilepath, file.source);
  return new Compiler(layout);
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

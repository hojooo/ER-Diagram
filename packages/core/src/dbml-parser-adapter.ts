import { Parser, type Database } from "@dbml/core";
import { Filepath } from "@dbml/parse";
import { diagnosticSchema, type Diagnostic } from "@er-diagram/contracts";

import {
  interpretDbml,
  type DbmlParseFailure,
  type DbmlParseSuccess,
  type RegisteredSourceFile,
} from "./dbml-parser.js";
import type { DbmlSourceContext } from "./dbml-source-range.js";
import { sha256Utf8 } from "./hash.js";
import { normalizeSchemaGraph, SchemaGraphNormalizationError } from "./normalize-schema-graph.js";
import type { SchemaGraph } from "./schema-graph.js";

const DEFAULT_FILEPATH = "/main.dbml";
const SINGLE_FILE_COMPILER_PATH = Filepath.from(DEFAULT_FILEPATH);

type AdapterCompilationResult =
  | {
      ok: true;
      graph: SchemaGraph;
      database: Database;
      sourceContext: Required<DbmlSourceContext>;
    }
  | { ok: false; diagnostics: Diagnostic[] };

export type DbmlAdapterParseResult =
  | (DbmlParseSuccess & {
      database: Database;
      sourceContext: Required<DbmlSourceContext>;
    })
  | DbmlParseFailure;

/** Package-internal adapter entrypoint. Parser models must never leave `packages/core`. */
export async function parseDbmlV2ForAdapter(
  source: string,
  filepath = DEFAULT_FILEPATH,
): Promise<DbmlAdapterParseResult> {
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
  const compiled = await compileDbmlAdapter(parser, file, [file]);

  return compiled.ok
    ? {
        ok: true,
        sourceHash,
        parserInputHash,
        graph: compiled.graph,
        database: compiled.database,
        sourceContext: compiled.sourceContext,
      }
    : { ok: false, sourceHash, parserInputHash, diagnostics: compiled.diagnostics };
}

async function compileDbmlAdapter(
  parser: Parser,
  entrypoint: RegisteredSourceFile,
  files: readonly RegisteredSourceFile[],
): Promise<AdapterCompilationResult> {
  const interpreted = interpretDbml(parser.DBMLCompiler, entrypoint, files);
  if (!interpreted.ok) return interpreted;

  try {
    const database = Parser.parseJSONToDatabase(
      interpreted.rawDatabase as Parameters<typeof Parser.parseJSONToDatabase>[0],
    );
    const graph = await normalizeSchemaGraph(database, {
      fallbackFilepath: entrypoint.publicFilepath,
      forceFilepath: false,
      publicFilepathByCompilerPath: interpreted.sourceContext.publicFilepathByCompilerPath,
      sourceByPublicFilepath: interpreted.sourceContext.sourceByPublicFilepath,
      sourceText: interpreted.sourceText,
    });
    return {
      ok: true,
      graph: { ...graph, diagnostics: interpreted.diagnostics },
      database,
      sourceContext: interpreted.sourceContext,
    };
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

function errorDiagnostic(code: string, message: string): Diagnostic {
  return diagnosticSchema.parse({ code, message, severity: "ERROR" });
}

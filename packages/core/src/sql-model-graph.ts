import { ModelExporter, type Database } from "@dbml/core";
import { parseDbmlV2 } from "./dbml-parser.js";
import { sha256Utf8 } from "./hash.js";
import type { SchemaGraph } from "./schema-graph.js";
import type { SqlSemanticVerification } from "./sql-import.js";
import { verifySqlModelToGraph } from "./sql-import-semantics.js";

export type SqlModelGraphConversionResult =
  | {
      readonly ok: true;
      readonly dbml: string;
      readonly dbmlHash: string;
      readonly graph: SchemaGraph;
      readonly semanticVerification: SqlSemanticVerification;
    }
  | {
      readonly ok: false;
      readonly failure: "DBML_EXPORT" | "DBML_PARSE";
      readonly dbmlHash: string | null;
    };

/** Package-internal SQL model adapter shared by import and export verification. */
export async function convertSqlModelToGraph(
  database: Database,
  filepath: string,
  options: {
    readonly normalizedModel?: ReturnType<Database["normalize"]>;
  } = {},
): Promise<SqlModelGraphConversionResult> {
  let dbml: string;
  try {
    dbml = ModelExporter.export(options.normalizedModel ?? database.normalize(), "dbml", {
      includeRecords: false,
    });
  } catch {
    return { ok: false, failure: "DBML_EXPORT", dbmlHash: null };
  }

  const dbmlHash = await sha256Utf8(dbml);
  const parsed = await parseDbmlV2(dbml, filepath);
  if (!parsed.ok) {
    return { ok: false, failure: "DBML_PARSE", dbmlHash };
  }

  return {
    ok: true,
    dbml,
    dbmlHash,
    graph: parsed.graph,
    semanticVerification: await verifySqlModelToGraph(database, parsed.graph),
  };
}

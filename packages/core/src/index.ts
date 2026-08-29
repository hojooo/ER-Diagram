export const corePackage = "@er-diagram/core";

export * from "./application/layout.js";
export * from "./application/layout-application.js";
export * from "./application/project.js";
export * from "./application/project-application.js";
export * from "./dbml-parser.js";
export * from "./hash.js";
export * from "./schema-graph.js";
export {
  computeSchemaHash,
  diffSchemaGraphs,
  SCHEMA_SEMANTICS_VERSION,
} from "./schema-semantics.js";
export type {
  SchemaElementChange,
  SchemaGraphDiff,
  SchemaRenameCandidate,
} from "./schema-semantics.js";
export * from "./sql-capabilities.js";
export * from "./sql-import.js";
export * from "./sql-smoke.js";

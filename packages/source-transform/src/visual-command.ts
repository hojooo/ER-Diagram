import type { VisualCommand } from "@er-diagram/contracts";
import { transformGroupViewCommand } from "./groups-views.js";
import { transformRelationshipIndexCheckCommand } from "./relationships-indexes.js";
import { transformTableColumnCommand } from "./table-column.js";
import type { VisualSourceTransformResult } from "./types.js";

const TABLE_COLUMN_KINDS = new Set<VisualCommand["kind"]>([
  "CREATE_TABLE",
  "UPDATE_TABLE",
  "RENAME_TABLE",
  "DELETE_TABLE",
  "CREATE_COLUMN",
  "ALTER_COLUMN",
  "DELETE_COLUMN",
]);

const RELATIONSHIP_INDEX_CHECK_KINDS = new Set<VisualCommand["kind"]>([
  "CREATE_REFERENCE",
  "UPDATE_REFERENCE",
  "DELETE_REFERENCE",
  "CREATE_INDEX",
  "UPDATE_INDEX",
  "DELETE_INDEX",
  "CREATE_CHECK",
  "UPDATE_CHECK",
  "DELETE_CHECK",
]);

export function transformVisualCommand(
  source: string,
  command: VisualCommand,
  filepath = "/main.dbml",
): Promise<VisualSourceTransformResult> {
  if (TABLE_COLUMN_KINDS.has(command.kind)) {
    return transformTableColumnCommand(source, command as never, filepath);
  }
  if (RELATIONSHIP_INDEX_CHECK_KINDS.has(command.kind)) {
    return transformRelationshipIndexCheckCommand(source, command as never, filepath);
  }
  return transformGroupViewCommand(source, command as never, filepath);
}

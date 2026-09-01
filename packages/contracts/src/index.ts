import { z } from "zod";
import { dbmlParserWorkerLimitsSchema } from "./resource-limits.js";

export * from "./resource-limits.js";

export const contractPackage = "@er-diagram/contracts";

export const primaryDialectSchema = z.enum(["POSTGRESQL", "MYSQL"]);
export type PrimaryDialect = z.infer<typeof primaryDialectSchema>;

export const sqlDataStatementHandlingSchema = z.enum(["REJECT", "CONFIRM_DDL_ONLY"]);
export type SqlDataStatementHandling = z.infer<typeof sqlDataStatementHandlingSchema>;

export const originalSqlRetentionModeSchema = z.enum(["DISCARD", "RETAIN"]);
export type OriginalSqlRetentionMode = z.infer<typeof originalSqlRetentionModeSchema>;

export const sourceRangeSchema = z
  .object({
    filepath: z.string().min(1),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
  })
  .strict()
  .superRefine((range, context) => {
    if (range.endOffset < range.startOffset) {
      context.addIssue({
        code: "custom",
        message: "endOffset must be greater than or equal to startOffset.",
        path: ["endOffset"],
      });
    }
    if (range.endLine < range.startLine) {
      context.addIssue({
        code: "custom",
        message: "endLine must be greater than or equal to startLine.",
        path: ["endLine"],
      });
    }
    if (range.endLine === range.startLine && range.endColumn < range.startColumn) {
      context.addIssue({
        code: "custom",
        message: "endColumn must be greater than or equal to startColumn on the same line.",
        path: ["endColumn"],
      });
    }
  });
export type SourceRange = z.infer<typeof sourceRangeSchema>;

export const diagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(["ERROR", "WARNING", "INFO"]),
    range: sourceRangeSchema.optional(),
  })
  .strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof sha256HexSchema>;

export const dbmlParserWorkerRequestSchema = z
  .object({
    type: z.literal("PARSE_DBML"),
    requestId: z.uuid(),
    filepath: z.literal("/main.dbml"),
    source: z.string(),
    sourceHash: sha256HexSchema,
    limits: dbmlParserWorkerLimitsSchema,
  })
  .strict();
export type DbmlParserWorkerRequest = z.infer<typeof dbmlParserWorkerRequestSchema>;

const dbmlParserWorkerResponseBase = {
  type: z.literal("DBML_PARSE_RESULT"),
  requestId: z.uuid(),
  sourceHash: sha256HexSchema,
  parserInputHash: sha256HexSchema,
  parserVersion: z.string().min(1),
  diagnostics: z.array(diagnosticSchema),
};

const dbmlParserWorkerSuccessResponseSchema = z
  .object({
    ...dbmlParserWorkerResponseBase,
    ok: z.literal(true),
    graph: z.unknown().refine((value) => value !== undefined, {
      message: "graph is required for a successful parse.",
    }),
  })
  .strict();

const dbmlParserWorkerFailureResponseSchema = z
  .object({
    ...dbmlParserWorkerResponseBase,
    ok: z.literal(false),
  })
  .strict();

export const dbmlParserWorkerResponseSchema = z.discriminatedUnion("ok", [
  dbmlParserWorkerSuccessResponseSchema,
  dbmlParserWorkerFailureResponseSchema,
]);
export type DbmlParserWorkerResponse = z.infer<typeof dbmlParserWorkerResponseSchema>;

export const commandIdSchema = z.uuid();
export type CommandId = z.infer<typeof commandIdSchema>;

export const correlationIdSchema = z.uuid();
export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const projectIdSchema = z.uuidv7();
export type ProjectId = z.infer<typeof projectIdSchema>;

export const schemaRevisionNoSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const layoutRevisionNoSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const utcIsoTimestampSchema = z.iso.datetime({ precision: 3 });

export const diagramDetailLevelSchema = z.enum(["NAME_ONLY", "KEYS_ONLY", "FULL"]);
export type DiagramDetailLevel = z.infer<typeof diagramDetailLevelSchema>;

export const diagramPositionSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
export type DiagramPosition = z.infer<typeof diagramPositionSchema>;

export const diagramViewportSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive(),
  })
  .strict();
export type DiagramViewport = z.infer<typeof diagramViewportSchema>;

export const diagramViewKeySchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
export const layoutElementKeySchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);

const uniqueLayoutElementKeysSchema = z
  .array(layoutElementKeySchema)
  .superRefine((keys, context) => {
    const seen = new Set<string>();
    for (const [index, key] of keys.entries()) {
      if (seen.has(key)) {
        context.addIssue({ code: "custom", message: "Layout keys must be unique.", path: [index] });
      }
      seen.add(key);
    }
  });

export const diagramLayoutValueSchema = z
  .object({
    positions: z.record(layoutElementKeySchema, diagramPositionSchema),
    collapsedGroupKeys: uniqueLayoutElementKeysSchema,
    hiddenElementKeys: uniqueLayoutElementKeysSchema,
    viewport: diagramViewportSchema,
    detailLevel: diagramDetailLevelSchema,
    baseSchemaHash: sha256HexSchema,
  })
  .strict();
export type DiagramLayoutValue = z.infer<typeof diagramLayoutValueSchema>;

export const diagramLayoutSchema = diagramLayoutValueSchema
  .extend({
    projectId: projectIdSchema,
    viewKey: diagramViewKeySchema,
    revisionNo: layoutRevisionNoSchema,
  })
  .strict();
export type DiagramLayout = z.infer<typeof diagramLayoutSchema>;

export const draftValiditySchema = z.enum(["VALID", "INVALID"]);
export type DraftValidity = z.infer<typeof draftValiditySchema>;

export const schemaRevisionOriginSchema = z.enum([
  "SOURCE_EDIT",
  "VISUAL_COMMAND",
  "SQL_IMPORT",
  "RESTORE",
  "PARSER_MIGRATION",
]);
export type SchemaRevisionOrigin = z.infer<typeof schemaRevisionOriginSchema>;

export const diagnosticSummarySchema = z
  .object({
    errors: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    warnings: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    infos: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    parserVersion: z.string().min(1),
  })
  .strict();
export type DiagnosticSummary = z.infer<typeof diagnosticSummarySchema>;

export const projectSchema = z
  .object({
    id: projectIdSchema,
    name: z.string().min(1),
    primaryDialect: primaryDialectSchema,
    draftSource: z.string(),
    draftHash: z.string().min(1),
    lastValidRevisionId: projectIdSchema.nullable(),
    parserVersion: z.string().min(1),
    schemaRevisionNo: schemaRevisionNoSchema,
    layoutRevisionNo: layoutRevisionNoSchema,
    createdAt: utcIsoTimestampSchema,
    updatedAt: utcIsoTimestampSchema,
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

export const schemaRevisionSchema = z
  .object({
    id: projectIdSchema,
    projectId: projectIdSchema,
    revisionNo: schemaRevisionNoSchema,
    source: z.string(),
    sourceHash: z.string().min(1),
    validity: draftValiditySchema,
    origin: schemaRevisionOriginSchema,
    parserVersion: z.string().min(1),
    diagnosticSummary: diagnosticSummarySchema,
    createdAt: utcIsoTimestampSchema,
  })
  .strict();
export type SchemaRevision = z.infer<typeof schemaRevisionSchema>;

export const schemaRevisionSummarySchema = schemaRevisionSchema.omit({ source: true });
export type SchemaRevisionSummary = z.infer<typeof schemaRevisionSummarySchema>;

export const projectStateSchema = z
  .object({
    project: projectSchema,
    currentRevision: schemaRevisionSchema,
    lastValidRevision: schemaRevisionSchema.nullable(),
  })
  .strict();
export type ProjectState = z.infer<typeof projectStateSchema>;

export const projectSummarySchema = z
  .object({
    id: projectIdSchema,
    name: z.string().min(1),
    primaryDialect: primaryDialectSchema,
    parserVersion: z.string().min(1),
    schemaRevisionNo: schemaRevisionNoSchema,
    layoutRevisionNo: layoutRevisionNoSchema,
    draftValidity: draftValiditySchema,
    diagnosticSummary: diagnosticSummarySchema,
    createdAt: utcIsoTimestampSchema,
    updatedAt: utcIsoTimestampSchema,
  })
  .strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

const createProjectOperationSchema = z
  .object({
    operation: z.literal("CREATE"),
    commandId: commandIdSchema,
    name: z.string(),
    primaryDialect: primaryDialectSchema,
    source: z.string(),
  })
  .strict();

const duplicateProjectOperationSchema = z
  .object({
    operation: z.literal("DUPLICATE"),
    commandId: commandIdSchema,
    sourceProjectId: projectIdSchema,
    name: z.string(),
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
  })
  .strict();

const createProjectFromSqlImportOperationSchema = z
  .object({
    operation: z.literal("CREATE_FROM_SQL_IMPORT"),
    commandId: commandIdSchema,
    name: z.string(),
    primaryDialect: primaryDialectSchema,
    source: z.string(),
    previewHash: sha256HexSchema,
    originalSqlRetention: originalSqlRetentionModeSchema.optional(),
    dataStatementHandling: sqlDataStatementHandlingSchema.optional(),
  })
  .strict();

export const createProjectRequestSchema = z.discriminatedUnion("operation", [
  createProjectOperationSchema,
  duplicateProjectOperationSchema,
  createProjectFromSqlImportOperationSchema,
]);
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const projectParamsSchema = z.object({ projectId: projectIdSchema }).strict();
export type ProjectParams = z.infer<typeof projectParamsSchema>;

export const revisionParamsSchema = z
  .object({
    projectId: projectIdSchema,
    revisionNo: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type RevisionParams = z.infer<typeof revisionParamsSchema>;

export const layoutParamsSchema = z
  .object({ projectId: projectIdSchema, viewKey: diagramViewKeySchema })
  .strict();
export type LayoutParams = z.infer<typeof layoutParamsSchema>;

export const renameProjectRequestSchema = z
  .object({
    commandId: commandIdSchema,
    name: z.string(),
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
  })
  .strict();
export type RenameProjectRequest = z.infer<typeof renameProjectRequestSchema>;

export const deleteProjectRequestSchema = z
  .object({
    commandId: commandIdSchema,
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
  })
  .strict();
export type DeleteProjectRequest = z.infer<typeof deleteProjectRequestSchema>;

export const saveDraftRequestSchema = z
  .object({
    commandId: commandIdSchema,
    source: z.string(),
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
  })
  .strict();
export type SaveDraftRequest = z.infer<typeof saveDraftRequestSchema>;

export const restoreRevisionRequestSchema = z
  .object({
    commandId: commandIdSchema,
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
  })
  .strict();
export type RestoreRevisionRequest = z.infer<typeof restoreRevisionRequestSchema>;

export const saveLayoutRequestSchema = z
  .object({
    commandId: commandIdSchema,
    expectedLayoutRevisionNo: layoutRevisionNoSchema,
    layout: diagramLayoutValueSchema,
  })
  .strict();
export type SaveLayoutRequest = z.infer<typeof saveLayoutRequestSchema>;

export const visualCommandKindSchema = z.enum([
  "CREATE_TABLE",
  "UPDATE_TABLE",
  "RENAME_TABLE",
  "DELETE_TABLE",
  "CREATE_COLUMN",
  "UPDATE_COLUMN",
  "RENAME_COLUMN",
  "REORDER_COLUMN",
  "DELETE_COLUMN",
  "CREATE_REFERENCE",
  "UPDATE_REFERENCE",
  "DELETE_REFERENCE",
  "CREATE_INDEX",
  "UPDATE_INDEX",
  "DELETE_INDEX",
  "CREATE_CHECK",
  "UPDATE_CHECK",
  "DELETE_CHECK",
  "UPDATE_GROUP_MEMBERSHIP",
  "UPDATE_DIAGRAM_VIEW",
]);
export type VisualCommandKind = z.infer<typeof visualCommandKindSchema>;

const visualIdentifierSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Identifier must not be blank.")
  .refine((value) => !/[\0\r\n]/u.test(value), "Identifier must be a single line.");

const visualNoteSchema = z
  .string()
  .refine((value) => !value.includes("\0"), "Note must not contain a null character.");

const visualExpressionSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Expression must not be blank.")
  .refine((value) => !value.includes("\0"), "Expression must not contain a null character.");

export const visualDbmlTypeSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "DBML type must not be blank.")
  .refine((value) => !/[\0\r\n{};]/u.test(value), "DBML type must be a safe single line.")
  .refine(
    (value) => !value.includes("//") && !value.includes("/*") && !value.includes("*/"),
    "DBML type must not contain a comment delimiter.",
  );
export type VisualDbmlType = z.infer<typeof visualDbmlTypeSchema>;

export const visualColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u);
export type VisualColor = z.infer<typeof visualColorSchema>;

function visualElementKeyFor(kind: string) {
  return z.string().regex(new RegExp(`^${kind}:.+`, "u"));
}

export const visualTableKeySchema = visualElementKeyFor("table");
export const visualColumnKeySchema = visualElementKeyFor("column");
export const visualReferenceKeySchema = visualElementKeyFor("reference");
export const visualIndexKeySchema = visualElementKeyFor("index");
export const visualCheckKeySchema = visualElementKeyFor("check");
export const visualGroupKeySchema = visualElementKeyFor("group");
export const visualViewKeySchema = visualElementKeyFor("view");
export const visualNoteKeySchema = visualElementKeyFor("note");
export const visualPartialKeySchema = visualElementKeyFor("partial");
export const visualPartialColumnKeySchema = visualElementKeyFor("partialColumn");
export const visualPartialIndexKeySchema = visualElementKeyFor("partialIndex");
export const visualPartialCheckKeySchema = visualElementKeyFor("partialCheck");

function uniqueStringArraySchema(itemSchema: z.ZodString) {
  return z.array(itemSchema).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: "Keys must be unique.",
          path: [index],
        });
      }
      seen.add(value);
    }
  });
}

const visualTableKeysSchema = uniqueStringArraySchema(visualTableKeySchema);
const visualColumnKeysSchema = uniqueStringArraySchema(visualColumnKeySchema);
const visualGroupKeysSchema = uniqueStringArraySchema(visualGroupKeySchema);
const visualNoteKeysSchema = uniqueStringArraySchema(visualNoteKeySchema);
const visualSchemaNamesSchema = uniqueStringArraySchema(visualIdentifierSchema);

function requireNonEmptyPatch(value: Record<string, unknown>, context: z.RefinementCtx): void {
  if (!Object.values(value).some((field) => field !== undefined)) {
    context.addIssue({ code: "custom", message: "At least one change is required." });
  }
}

const visualCommandBaseShape = {
  commandId: commandIdSchema,
  expectedSchemaRevisionNo: schemaRevisionNoSchema,
};

const visualColumnDefaultNumberSchema = z
  .object({ type: z.literal("number"), value: z.number().finite() })
  .strict();
const visualColumnDefaultStringSchema = z
  .object({ type: z.literal("string"), value: z.string() })
  .strict();
const visualColumnDefaultBooleanSchema = z
  .object({ type: z.literal("boolean"), value: z.boolean() })
  .strict();
const visualColumnDefaultExpressionSchema = z
  .object({ type: z.literal("expression"), value: visualExpressionSchema })
  .strict();
const visualColumnDefaultNullSchema = z
  .object({ type: z.literal("null"), value: z.null() })
  .strict();

export const visualColumnDefaultSchema = z.discriminatedUnion("type", [
  visualColumnDefaultNumberSchema,
  visualColumnDefaultStringSchema,
  visualColumnDefaultBooleanSchema,
  visualColumnDefaultExpressionSchema,
  visualColumnDefaultNullSchema,
]);
export type VisualColumnDefault = z.infer<typeof visualColumnDefaultSchema>;

const visualColumnValueSchema = z
  .object({
    name: visualIdentifierSchema,
    type: visualDbmlTypeSchema,
    primaryKey: z.boolean(),
    unique: z.boolean(),
    notNull: z.boolean(),
    default: visualColumnDefaultSchema.nullable(),
    increment: z.boolean(),
    note: visualNoteSchema.nullable(),
  })
  .strict();

const visualInitialColumnsSchema = z
  .array(visualColumnValueSchema)
  .min(1)
  .superRefine((columns, context) => {
    const names = new Set<string>();
    for (const [index, column] of columns.entries()) {
      if (names.has(column.name)) {
        context.addIssue({
          code: "custom",
          message: "Initial column names must be unique.",
          path: [index, "name"],
        });
      }
      names.add(column.name);
    }
  });

const visualTableValueSchema = z
  .object({
    schemaName: visualIdentifierSchema,
    name: visualIdentifierSchema,
    note: visualNoteSchema.nullable(),
    color: visualColorSchema.nullable(),
    columns: visualInitialColumnsSchema,
  })
  .strict();

const visualTableChangesSchema = z
  .object({
    note: visualNoteSchema.nullable().optional(),
    color: visualColorSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireNonEmptyPatch);

export const createTableCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("CREATE_TABLE"),
    table: visualTableValueSchema,
  })
  .strict();
export type CreateTableCommand = z.infer<typeof createTableCommandSchema>;

export const updateTableCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("UPDATE_TABLE"),
    targetTableKey: visualTableKeySchema,
    changes: visualTableChangesSchema,
  })
  .strict();
export type UpdateTableCommand = z.infer<typeof updateTableCommandSchema>;

export const renameTableCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("RENAME_TABLE"),
    targetTableKey: visualTableKeySchema,
    newName: visualIdentifierSchema,
  })
  .strict();
export type RenameTableCommand = z.infer<typeof renameTableCommandSchema>;

export const deleteTableCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("DELETE_TABLE"),
    targetTableKey: visualTableKeySchema,
  })
  .strict();
export type DeleteTableCommand = z.infer<typeof deleteTableCommandSchema>;

const visualColumnChangesSchema = z
  .object({
    type: visualDbmlTypeSchema.optional(),
    primaryKey: z.boolean().optional(),
    unique: z.boolean().optional(),
    notNull: z.boolean().optional(),
    default: visualColumnDefaultSchema.nullable().optional(),
    increment: z.boolean().optional(),
    note: visualNoteSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireNonEmptyPatch);

export const createColumnCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("CREATE_COLUMN"),
    targetTableKey: visualTableKeySchema,
    column: visualColumnValueSchema,
  })
  .strict();
export type CreateColumnCommand = z.infer<typeof createColumnCommandSchema>;

export const updateColumnCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("UPDATE_COLUMN"),
    targetTableKey: visualTableKeySchema,
    targetColumnKey: visualColumnKeySchema,
    changes: visualColumnChangesSchema,
  })
  .strict();
export type UpdateColumnCommand = z.infer<typeof updateColumnCommandSchema>;

export const renameColumnCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("RENAME_COLUMN"),
    targetTableKey: visualTableKeySchema,
    targetColumnKey: visualColumnKeySchema,
    newName: visualIdentifierSchema,
  })
  .strict();
export type RenameColumnCommand = z.infer<typeof renameColumnCommandSchema>;

export const reorderColumnCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("REORDER_COLUMN"),
    targetTableKey: visualTableKeySchema,
    targetColumnKey: visualColumnKeySchema,
    beforeColumnKey: visualColumnKeySchema.nullable(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.beforeColumnKey === command.targetColumnKey) {
      context.addIssue({
        code: "custom",
        message: "A column cannot be ordered before itself.",
        path: ["beforeColumnKey"],
      });
    }
  });
export type ReorderColumnCommand = z.infer<typeof reorderColumnCommandSchema>;

export const deleteColumnCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("DELETE_COLUMN"),
    targetTableKey: visualTableKeySchema,
    targetColumnKey: visualColumnKeySchema,
  })
  .strict();
export type DeleteColumnCommand = z.infer<typeof deleteColumnCommandSchema>;

export const visualReferenceActionSchema = z.enum([
  "cascade",
  "restrict",
  "set null",
  "set default",
  "no action",
]);
export type VisualReferenceAction = z.infer<typeof visualReferenceActionSchema>;

export const visualReferenceMultiplicitySchema = z
  .object({
    min: z.union([z.literal(0), z.literal(1)]),
    max: z.union([z.literal(1), z.null()]),
  })
  .strict();
export type VisualReferenceMultiplicity = z.infer<typeof visualReferenceMultiplicitySchema>;

export const visualReferenceEndpointSchema = z
  .object({
    tableKey: visualTableKeySchema,
    columnKeys: visualColumnKeysSchema.min(1),
    multiplicity: visualReferenceMultiplicitySchema,
  })
  .strict();
export type VisualReferenceEndpoint = z.infer<typeof visualReferenceEndpointSchema>;

const visualReferenceEndpointsSchema = z
  .tuple([visualReferenceEndpointSchema, visualReferenceEndpointSchema])
  .superRefine((endpoints, context) => {
    if (endpoints[0].columnKeys.length !== endpoints[1].columnKeys.length) {
      context.addIssue({
        code: "custom",
        message: "Reference endpoints must contain the same number of columns.",
      });
    }
  });

const visualReferenceValueSchema = z
  .object({
    schemaName: visualIdentifierSchema,
    name: visualIdentifierSchema.nullable(),
    endpoints: visualReferenceEndpointsSchema,
    onDelete: visualReferenceActionSchema.nullable(),
    onUpdate: visualReferenceActionSchema.nullable(),
    color: visualColorSchema.nullable(),
    inactive: z.boolean(),
  })
  .strict();

const visualReferenceChangesSchema = z
  .object({
    name: visualIdentifierSchema.nullable().optional(),
    endpoints: visualReferenceEndpointsSchema.optional(),
    onDelete: visualReferenceActionSchema.nullable().optional(),
    onUpdate: visualReferenceActionSchema.nullable().optional(),
    color: visualColorSchema.nullable().optional(),
    inactive: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireNonEmptyPatch);

export const createReferenceCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("CREATE_REFERENCE"),
    reference: visualReferenceValueSchema,
  })
  .strict();
export type CreateReferenceCommand = z.infer<typeof createReferenceCommandSchema>;

export const updateReferenceCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("UPDATE_REFERENCE"),
    targetReferenceKey: visualReferenceKeySchema,
    changes: visualReferenceChangesSchema,
  })
  .strict();
export type UpdateReferenceCommand = z.infer<typeof updateReferenceCommandSchema>;

export const deleteReferenceCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("DELETE_REFERENCE"),
    targetReferenceKey: visualReferenceKeySchema,
  })
  .strict();
export type DeleteReferenceCommand = z.infer<typeof deleteReferenceCommandSchema>;

const visualIndexColumnTermSchema = z
  .object({ kind: z.literal("COLUMN"), columnKey: visualColumnKeySchema })
  .strict();
const visualIndexExpressionTermSchema = z
  .object({ kind: z.literal("EXPRESSION"), expression: visualExpressionSchema })
  .strict();

export const visualIndexTermSchema = z.discriminatedUnion("kind", [
  visualIndexColumnTermSchema,
  visualIndexExpressionTermSchema,
]);
export type VisualIndexTerm = z.infer<typeof visualIndexTermSchema>;

const visualIndexTermsSchema = z.array(visualIndexTermSchema).min(1);
const visualIndexValueSchema = z
  .object({
    name: visualIdentifierSchema.nullable(),
    terms: visualIndexTermsSchema,
    type: visualDbmlTypeSchema.nullable(),
    unique: z.boolean(),
    primaryKey: z.boolean(),
    note: visualNoteSchema.nullable(),
  })
  .strict();

const visualIndexChangesSchema = z
  .object({
    name: visualIdentifierSchema.nullable().optional(),
    terms: visualIndexTermsSchema.optional(),
    type: visualDbmlTypeSchema.nullable().optional(),
    unique: z.boolean().optional(),
    primaryKey: z.boolean().optional(),
    note: visualNoteSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireNonEmptyPatch);

export const createIndexCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("CREATE_INDEX"),
    targetTableKey: visualTableKeySchema,
    index: visualIndexValueSchema,
  })
  .strict();
export type CreateIndexCommand = z.infer<typeof createIndexCommandSchema>;

export const updateIndexCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("UPDATE_INDEX"),
    targetTableKey: visualTableKeySchema,
    targetIndexKey: visualIndexKeySchema,
    changes: visualIndexChangesSchema,
  })
  .strict();
export type UpdateIndexCommand = z.infer<typeof updateIndexCommandSchema>;

export const deleteIndexCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("DELETE_INDEX"),
    targetTableKey: visualTableKeySchema,
    targetIndexKey: visualIndexKeySchema,
  })
  .strict();
export type DeleteIndexCommand = z.infer<typeof deleteIndexCommandSchema>;

const visualCheckValueSchema = z
  .object({
    name: visualIdentifierSchema.nullable(),
    expression: visualExpressionSchema,
  })
  .strict();

const visualCheckChangesSchema = z
  .object({
    name: visualIdentifierSchema.nullable().optional(),
    expression: visualExpressionSchema.optional(),
  })
  .strict()
  .superRefine(requireNonEmptyPatch);

const visualCheckOwnerShape = {
  targetTableKey: visualTableKeySchema,
  ownerColumnKey: visualColumnKeySchema.nullable(),
};

export const createCheckCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("CREATE_CHECK"),
    ...visualCheckOwnerShape,
    check: visualCheckValueSchema,
  })
  .strict();
export type CreateCheckCommand = z.infer<typeof createCheckCommandSchema>;

export const updateCheckCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("UPDATE_CHECK"),
    ...visualCheckOwnerShape,
    targetCheckKey: visualCheckKeySchema,
    changes: visualCheckChangesSchema,
  })
  .strict();
export type UpdateCheckCommand = z.infer<typeof updateCheckCommandSchema>;

export const deleteCheckCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("DELETE_CHECK"),
    ...visualCheckOwnerShape,
    targetCheckKey: visualCheckKeySchema,
  })
  .strict();
export type DeleteCheckCommand = z.infer<typeof deleteCheckCommandSchema>;

export const updateGroupMembershipCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("UPDATE_GROUP_MEMBERSHIP"),
    targetGroupKey: visualGroupKeySchema,
    addTableKeys: visualTableKeysSchema,
    removeTableKeys: visualTableKeysSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.addTableKeys.length === 0 && command.removeTableKeys.length === 0) {
      context.addIssue({ code: "custom", message: "At least one membership change is required." });
    }
    const removed = new Set(command.removeTableKeys);
    for (const [index, key] of command.addTableKeys.entries()) {
      if (removed.has(key)) {
        context.addIssue({
          code: "custom",
          message: "A table cannot be added and removed in the same command.",
          path: ["addTableKeys", index],
        });
      }
    }
  });
export type UpdateGroupMembershipCommand = z.infer<typeof updateGroupMembershipCommandSchema>;

const visualDiagramViewChangesSchema = z
  .object({
    visibleTableKeys: visualTableKeysSchema.nullable().optional(),
    visibleNoteKeys: visualNoteKeysSchema.nullable().optional(),
    visibleGroupKeys: visualGroupKeysSchema.nullable().optional(),
    visibleSchemaNames: visualSchemaNamesSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireNonEmptyPatch);

export const updateDiagramViewCommandSchema = z
  .object({
    ...visualCommandBaseShape,
    kind: z.literal("UPDATE_DIAGRAM_VIEW"),
    targetViewKey: visualViewKeySchema,
    changes: visualDiagramViewChangesSchema,
  })
  .strict();
export type UpdateDiagramViewCommand = z.infer<typeof updateDiagramViewCommandSchema>;

export const visualCommandSchema = z.discriminatedUnion("kind", [
  createTableCommandSchema,
  updateTableCommandSchema,
  renameTableCommandSchema,
  deleteTableCommandSchema,
  createColumnCommandSchema,
  updateColumnCommandSchema,
  renameColumnCommandSchema,
  reorderColumnCommandSchema,
  deleteColumnCommandSchema,
  createReferenceCommandSchema,
  updateReferenceCommandSchema,
  deleteReferenceCommandSchema,
  createIndexCommandSchema,
  updateIndexCommandSchema,
  deleteIndexCommandSchema,
  createCheckCommandSchema,
  updateCheckCommandSchema,
  deleteCheckCommandSchema,
  updateGroupMembershipCommandSchema,
  updateDiagramViewCommandSchema,
]);
export type VisualCommand = z.infer<typeof visualCommandSchema>;
export const visualCommandRequestSchema = visualCommandSchema;
export type VisualCommandRequest = z.infer<typeof visualCommandRequestSchema>;

const visualCommandPartialElementKeySchema = z.union([
  visualPartialColumnKeySchema,
  visualPartialIndexKeySchema,
  visualPartialCheckKeySchema,
]);

const visualCommandAffectedTableSchema = z
  .object({
    tableKey: visualTableKeySchema,
    injectionRange: sourceRangeSchema,
  })
  .strict();

const visualCommandAffectedTablesSchema = z
  .array(visualCommandAffectedTableSchema)
  .min(1)
  .superRefine((affectedTables, context) => {
    const tableKeys = new Set<string>();
    const injectionRanges = new Set<string>();
    let previousTableKey: string | undefined;
    for (const [index, affectedTable] of affectedTables.entries()) {
      if (tableKeys.has(affectedTable.tableKey)) {
        context.addIssue({
          code: "custom",
          message: "Affected table keys must be unique.",
          path: [index, "tableKey"],
        });
      }
      tableKeys.add(affectedTable.tableKey);

      if (
        previousTableKey !== undefined &&
        compareCodeUnits(previousTableKey, affectedTable.tableKey) >= 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Affected tables must be sorted by stable key.",
          path: [index, "tableKey"],
        });
      }
      previousTableKey = affectedTable.tableKey;

      const { filepath, startOffset, endOffset } = affectedTable.injectionRange;
      const rangeIdentity = `${filepath}\u0000${String(startOffset)}\u0000${String(endOffset)}`;
      if (injectionRanges.has(rangeIdentity)) {
        context.addIssue({
          code: "custom",
          message: "Affected table injection ranges must be unique.",
          path: [index, "injectionRange"],
        });
      }
      injectionRanges.add(rangeIdentity);
    }
  });

export const visualCommandPartialImpactSchema = z
  .object({
    partialKey: visualPartialKeySchema,
    partialName: visualIdentifierSchema,
    partialElementKey: visualCommandPartialElementKeySchema,
    definitionRange: sourceRangeSchema,
    affectedTables: visualCommandAffectedTablesSchema,
  })
  .strict();
export type VisualCommandPartialImpact = z.infer<typeof visualCommandPartialImpactSchema>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const sqlCapabilityIdSchema = z.enum([
  "ALTER_ADD_FOREIGN_KEY",
  "ALTER_ADD_UNIQUE",
  "ALTER_COLUMN_MUTATION",
  "ARRAY_BUILTIN",
  "ARRAY_SCHEMA_ENUM",
  "AUTO_INCREMENT",
  "BASIC_CONSTRAINTS",
  "COMMENTS",
  "COMPOSITE_KEYS",
  "COPY_DATA",
  "CREATE_TABLE",
  "DML",
  "DROP_STATEMENT",
  "ENUM",
  "FOREIGN_KEY_ACTIONS",
  "FUNCTION_INDEX",
  "GENERATED_COLUMN",
  "IDENTITY",
  "INDEX_METHODS",
  "MYSQL_INDEXES",
  "MYSQL_TABLE_OPTIONS",
  "PARTIAL_INDEX",
  "PROCEDURE_OR_FUNCTION_BODY",
  "SCHEMA_QUALIFIED_TABLE",
  "SERIAL",
  "TABLESPACE",
  "TRIGGER",
  "VIEW",
]);
export type SqlCapabilityId = z.infer<typeof sqlCapabilityIdSchema>;

export const schemaElementKindSchema = z.enum([
  "project",
  "note",
  "table",
  "column",
  "index",
  "check",
  "enum",
  "enumValue",
  "reference",
  "group",
  "partial",
  "partialColumn",
  "partialIndex",
  "partialCheck",
  "view",
]);
export type SchemaElementKind = z.infer<typeof schemaElementKindSchema>;

export const conversionStatusSchema = z.enum([
  "EXACT",
  "NORMALIZED",
  "PARTIAL",
  "UNSUPPORTED",
  "ERROR",
]);
export type ConversionStatus = z.infer<typeof conversionStatusSchema>;

export const sqlStatementKindSchema = z.enum([
  "CREATE_SCHEMA",
  "CREATE_TABLE",
  "CREATE_ENUM",
  "CREATE_INDEX",
  "ALTER_TABLE",
  "COMMENT",
  "VIEW",
  "DROP",
  "TRIGGER",
  "ROUTINE",
  "DML",
  "COPY",
  "UNKNOWN",
]);
export type SqlStatementKind = z.infer<typeof sqlStatementKindSchema>;

const schemaElementAddOrDeleteSchema = z
  .object({
    operation: z.enum(["ADD", "DELETE"]),
    elementKind: schemaElementKindSchema,
    key: z.string().min(1),
    parentKey: z.string().min(1).nullable(),
  })
  .strict();

const schemaElementUpdateSchema = z
  .object({
    operation: z.literal("UPDATE"),
    elementKind: schemaElementKindSchema,
    key: z.string().min(1),
    parentKey: z.string().min(1).nullable(),
    changedFields: z.array(z.string().min(1)),
  })
  .strict();

export const schemaElementChangeSchema = z.union([
  schemaElementAddOrDeleteSchema,
  schemaElementUpdateSchema,
]);
export type SchemaElementChange = z.infer<typeof schemaElementChangeSchema>;

export const sqlClauseConversionSchema = z
  .object({
    clauseNo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    capabilityId: sqlCapabilityIdSchema.nullable(),
    status: conversionStatusSchema,
    code: z.string().min(1),
    message: z.string().min(1),
    range: sourceRangeSchema,
  })
  .strict();
export type SqlClauseConversion = z.infer<typeof sqlClauseConversionSchema>;

export const sqlStatementConversionSchema = z
  .object({
    statementNo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: sqlStatementKindSchema,
    capabilityId: sqlCapabilityIdSchema.nullable(),
    status: conversionStatusSchema,
    code: z.string().min(1),
    message: z.string().min(1),
    range: sourceRangeSchema,
    clauses: z.array(sqlClauseConversionSchema),
  })
  .strict();
export type SqlStatementConversion = z.infer<typeof sqlStatementConversionSchema>;

const sqlSemanticVerificationNotRunSchema = z
  .object({
    status: z.literal("NOT_RUN"),
    sourceModelHash: z.null(),
    candidateSchemaHash: z.null(),
    changes: z.tuple([]),
  })
  .strict();

const sqlSemanticVerificationVerifiedSchema = z
  .object({
    status: z.literal("VERIFIED"),
    sourceModelHash: sha256HexSchema,
    candidateSchemaHash: sha256HexSchema,
    changes: z.tuple([]),
  })
  .strict();

const sqlSemanticVerificationFailedSchema = z
  .object({
    status: z.literal("FAILED"),
    sourceModelHash: sha256HexSchema,
    candidateSchemaHash: sha256HexSchema,
    changes: z.array(schemaElementChangeSchema),
  })
  .strict();

export const sqlSemanticVerificationSchema = z.discriminatedUnion("status", [
  sqlSemanticVerificationNotRunSchema,
  sqlSemanticVerificationVerifiedSchema,
  sqlSemanticVerificationFailedSchema,
]);
export type SqlSemanticVerification = z.infer<typeof sqlSemanticVerificationSchema>;

export const conversionReportSchema = z
  .object({
    reportVersion: z.literal(1),
    dialect: primaryDialectSchema,
    sourceFilepath: z.string().min(1),
    sourceHash: sha256HexSchema,
    parserInputHash: sha256HexSchema,
    parserVersions: z
      .object({ dbmlCore: z.literal("9.1.1"), dbmlParse: z.literal("9.1.1") })
      .strict(),
    capabilityMatrixVersion: z.literal(1),
    schemaSemanticsVersion: z.literal(1),
    overallStatus: conversionStatusSchema,
    applyEligible: z.boolean(),
    candidateDbmlHash: sha256HexSchema.nullable(),
    statements: z.array(sqlStatementConversionSchema),
    diagnostics: z.array(diagnosticSchema),
    semanticVerification: sqlSemanticVerificationSchema,
  })
  .strict();
export type ConversionReport = z.infer<typeof conversionReportSchema>;

export const sqlExportSourceSelectionSchema = z.enum(["CURRENT_DRAFT", "LAST_VALID"]);
export type SqlExportSourceSelection = z.infer<typeof sqlExportSourceSelectionSchema>;

export const sqlExportOccurrenceKindSchema = z.union([
  schemaElementKindSchema,
  z.enum(["record", "layout"]),
]);
export type SqlExportOccurrenceKind = z.infer<typeof sqlExportOccurrenceKindSchema>;

export const sqlExportOccurrenceSchema = z
  .object({
    elementKind: sqlExportOccurrenceKindSchema,
    elementKey: z.string().min(1).nullable(),
    range: sourceRangeSchema.nullable(),
  })
  .strict();
export type SqlExportOccurrence = z.infer<typeof sqlExportOccurrenceSchema>;

export const sqlExportReportEntrySchema = z
  .object({
    code: z.string().min(1),
    status: z.enum(["NORMALIZED", "PARTIAL", "UNSUPPORTED", "ERROR"]),
    message: z.string().min(1),
    occurrences: z.array(sqlExportOccurrenceSchema),
  })
  .strict();
export type SqlExportReportEntry = z.infer<typeof sqlExportReportEntrySchema>;

const sqlExportSemanticVerificationNotRunSchema = z
  .object({
    status: z.literal("NOT_RUN"),
    sourceExportableHash: z.null(),
    generatedExportableHash: z.null(),
    changes: z.tuple([]),
  })
  .strict();

const sqlExportSemanticVerificationVerifiedSchema = z
  .object({
    status: z.literal("VERIFIED"),
    sourceExportableHash: sha256HexSchema,
    generatedExportableHash: sha256HexSchema,
    changes: z.tuple([]),
  })
  .strict();

const sqlExportSemanticVerificationFailedSchema = z
  .object({
    status: z.literal("FAILED"),
    sourceExportableHash: sha256HexSchema,
    generatedExportableHash: sha256HexSchema,
    changes: z.array(schemaElementChangeSchema),
  })
  .strict();

export const sqlExportSemanticVerificationSchema = z.discriminatedUnion("status", [
  sqlExportSemanticVerificationNotRunSchema,
  sqlExportSemanticVerificationVerifiedSchema,
  sqlExportSemanticVerificationFailedSchema,
]);
export type SqlExportSemanticVerification = z.infer<typeof sqlExportSemanticVerificationSchema>;

export const sqlExportReportSchema = z
  .object({
    reportVersion: z.literal(1),
    exportSemanticsVersion: z.literal(1),
    sourceFilepath: z.string().min(1),
    sourceHash: sha256HexSchema,
    parserInputHash: sha256HexSchema,
    primaryDialect: primaryDialectSchema,
    targetDialect: primaryDialectSchema,
    parserVersions: z
      .object({ dbmlCore: z.literal("9.1.1"), dbmlParse: z.literal("9.1.1") })
      .strict(),
    schemaSemanticsVersion: z.literal(1),
    ddlKind: z.literal("EMPTY_SCHEMA_CREATE"),
    overallStatus: conversionStatusSchema,
    acknowledgementRequired: z.boolean(),
    generatedSqlHash: sha256HexSchema.nullable(),
    containsDataStatements: z.boolean(),
    entries: z.array(sqlExportReportEntrySchema),
    diagnostics: z.array(diagnosticSchema),
    semanticVerification: sqlExportSemanticVerificationSchema,
  })
  .strict();
export type SqlExportReport = z.infer<typeof sqlExportReportSchema>;

export const sqlExportRequestSchema = z
  .object({
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
    sourceSelection: sqlExportSourceSelectionSchema,
  })
  .strict();
export type SqlExportRequest = z.infer<typeof sqlExportRequestSchema>;

const sqlExportResponseBase = {
  sourceSelection: sqlExportSourceSelectionSchema,
  revisionNo: schemaRevisionNoSchema,
  sourceHash: sha256HexSchema,
  report: sqlExportReportSchema,
};

const sqlExportSuccessfulResponseSchema = z
  .object({
    ...sqlExportResponseBase,
    candidate: z.object({ sql: z.string(), sqlHash: sha256HexSchema }).strict(),
  })
  .strict();

const sqlExportFailedResponseSchema = z
  .object({ ...sqlExportResponseBase, candidate: z.null() })
  .strict();

export const sqlExportResponseSchema = z.union([
  sqlExportSuccessfulResponseSchema,
  sqlExportFailedResponseSchema,
]);
export type SqlExportResponse = z.infer<typeof sqlExportResponseSchema>;

export const sqlImportApplyReadinessSchema = z.enum([
  "READY",
  "CONVERSION_FAILED",
  "NO_SCHEMA_ELEMENTS",
  "DATA_EXCLUSION_CONFIRMATION_REQUIRED",
]);
export type SqlImportApplyReadiness = z.infer<typeof sqlImportApplyReadinessSchema>;

export const sqlImportDataHandlingSchema = z.enum([
  "NOT_PRESENT",
  "CONFIRMATION_REQUIRED",
  "CONFIRMED_DDL_ONLY",
]);
export type SqlImportDataHandling = z.infer<typeof sqlImportDataHandlingSchema>;

const uniquePositiveStatementNumbersSchema = z
  .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .superRefine((statementNos, context) => {
    const seen = new Set<number>();
    for (const [index, statementNo] of statementNos.entries()) {
      if (seen.has(statementNo)) {
        context.addIssue({
          code: "custom",
          message: "Data statement numbers must be unique.",
          path: [index],
        });
      }
      seen.add(statementNo);
    }
  });

export const sqlImportDataPolicyDecisionSchema = z
  .object({
    policyVersion: z.literal(1),
    dataStatementNos: uniquePositiveStatementNumbersSchema,
    dataHandling: sqlImportDataHandlingSchema,
    applyReadiness: sqlImportApplyReadinessSchema,
  })
  .strict();
export type SqlImportDataPolicyDecision = z.infer<typeof sqlImportDataPolicyDecisionSchema>;

export const sqlImportPreviewRequestSchema = z
  .object({
    commandId: commandIdSchema,
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
    dialect: primaryDialectSchema,
    source: z.string(),
    originalSqlRetention: originalSqlRetentionModeSchema.optional(),
  })
  .strict();
export type SqlImportPreviewRequest = z.infer<typeof sqlImportPreviewRequestSchema>;

const sqlImportPreviewResponseBase = {
  artifactId: projectIdSchema,
  createdAt: utcIsoTimestampSchema,
  baseSchemaRevisionNo: schemaRevisionNoSchema,
  previewHash: sha256HexSchema,
  originalSqlRetention: originalSqlRetentionModeSchema,
  report: conversionReportSchema,
  policy: sqlImportDataPolicyDecisionSchema,
};

const sqlImportSuccessfulPreviewResponseSchema = z
  .object({
    ...sqlImportPreviewResponseBase,
    artifactStatus: z.literal("PREVIEWED"),
    candidate: z.object({ dbml: z.string(), dbmlHash: sha256HexSchema }).strict(),
  })
  .strict();

const sqlImportFailedPreviewResponseSchema = z
  .object({
    ...sqlImportPreviewResponseBase,
    artifactStatus: z.literal("FAILED"),
    candidate: z.null(),
  })
  .strict();

export const sqlImportPreviewResponseSchema = z.discriminatedUnion("artifactStatus", [
  sqlImportSuccessfulPreviewResponseSchema,
  sqlImportFailedPreviewResponseSchema,
]);
export type SqlImportPreviewResponse = z.infer<typeof sqlImportPreviewResponseSchema>;

export const sqlImportStandalonePreviewRequestSchema = z
  .object({
    commandId: commandIdSchema,
    dialect: primaryDialectSchema,
    source: z.string(),
    originalSqlRetention: originalSqlRetentionModeSchema.optional(),
  })
  .strict();
export type SqlImportStandalonePreviewRequest = z.infer<
  typeof sqlImportStandalonePreviewRequestSchema
>;

const sqlImportStandalonePreviewResponseBase = {
  previewHash: sha256HexSchema,
  originalSqlRetention: originalSqlRetentionModeSchema,
  report: conversionReportSchema,
  policy: sqlImportDataPolicyDecisionSchema,
};

const sqlImportStandaloneSuccessfulPreviewResponseSchema = z
  .object({
    ...sqlImportStandalonePreviewResponseBase,
    previewStatus: z.literal("PREVIEWED"),
    candidate: z.object({ dbml: z.string(), dbmlHash: sha256HexSchema }).strict(),
  })
  .strict();

const sqlImportStandaloneFailedPreviewResponseSchema = z
  .object({
    ...sqlImportStandalonePreviewResponseBase,
    previewStatus: z.literal("FAILED"),
    candidate: z.null(),
  })
  .strict();

export const sqlImportStandalonePreviewResponseSchema = z.discriminatedUnion("previewStatus", [
  sqlImportStandaloneSuccessfulPreviewResponseSchema,
  sqlImportStandaloneFailedPreviewResponseSchema,
]);
export type SqlImportStandalonePreviewResponse = z.infer<
  typeof sqlImportStandalonePreviewResponseSchema
>;

export const sqlImportApplyRequestSchema = z
  .object({
    commandId: commandIdSchema,
    expectedSchemaRevisionNo: schemaRevisionNoSchema,
    artifactId: projectIdSchema,
    previewHash: sha256HexSchema,
    source: z.string(),
    dataStatementHandling: sqlDataStatementHandlingSchema.optional(),
  })
  .strict();
export type SqlImportApplyRequest = z.infer<typeof sqlImportApplyRequestSchema>;

export const sqlImportApplyResponseSchema = z
  .object({
    artifactId: projectIdSchema,
    artifactStatus: z.literal("APPLIED"),
    previewHash: sha256HexSchema,
    appliedAt: utcIsoTimestampSchema,
    policy: sqlImportDataPolicyDecisionSchema,
    state: projectStateSchema,
    diagnostics: z.array(diagnosticSchema),
    revisionCreated: z.literal(true),
  })
  .strict();
export type SqlImportApplyResponse = z.infer<typeof sqlImportApplyResponseSchema>;

export const sqlImportPreviewEvidenceSchema = z
  .object({
    projectId: projectIdSchema,
    baseSchemaRevisionNo: schemaRevisionNoSchema,
    dialect: primaryDialectSchema,
    sourceHash: sha256HexSchema,
    candidateDbmlHash: sha256HexSchema.nullable(),
    report: conversionReportSchema,
  })
  .strict();
export type SqlImportPreviewEvidence = z.infer<typeof sqlImportPreviewEvidenceSchema>;

export const sqlImportReplaceArtifactEnvelopeSchema = z
  .object({
    previewVersion: z.literal(1),
    evidence: sqlImportPreviewEvidenceSchema,
    previewHash: sha256HexSchema,
    previewPolicy: sqlImportDataPolicyDecisionSchema,
    appliedPolicy: sqlImportDataPolicyDecisionSchema.nullable(),
    originalSqlRetention: originalSqlRetentionModeSchema,
  })
  .strict();

export const sqlImportCreatePreviewEvidenceSchema = z
  .object({
    dialect: primaryDialectSchema,
    sourceHash: sha256HexSchema,
    candidateDbmlHash: sha256HexSchema.nullable(),
    report: conversionReportSchema,
  })
  .strict();
export type SqlImportCreatePreviewEvidence = z.infer<typeof sqlImportCreatePreviewEvidenceSchema>;

export const sqlImportCreateArtifactEnvelopeSchema = z
  .object({
    operation: z.literal("CREATE_PROJECT"),
    previewVersion: z.literal(1),
    evidence: sqlImportCreatePreviewEvidenceSchema,
    previewHash: sha256HexSchema,
    previewPolicy: sqlImportDataPolicyDecisionSchema,
    appliedPolicy: sqlImportDataPolicyDecisionSchema,
    originalSqlRetention: originalSqlRetentionModeSchema,
  })
  .strict();

export const sqlImportArtifactEnvelopeSchema = z.union([
  sqlImportReplaceArtifactEnvelopeSchema,
  sqlImportCreateArtifactEnvelopeSchema,
]);
export type SqlImportArtifactEnvelope = z.infer<typeof sqlImportArtifactEnvelopeSchema>;

export const projectsResponseSchema = z
  .object({ projects: z.array(projectSummarySchema) })
  .strict();
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

export const projectResponseSchema = z.object({ state: projectStateSchema }).strict();
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectMutationResponseSchema = z
  .object({
    state: projectStateSchema,
    diagnostics: z.array(diagnosticSchema),
    revisionCreated: z.boolean(),
  })
  .strict();
export type ProjectMutationResponse = z.infer<typeof projectMutationResponseSchema>;

export const projectRevisionsResponseSchema = z
  .object({ revisions: z.array(schemaRevisionSummarySchema) })
  .strict();
export type ProjectRevisionsResponse = z.infer<typeof projectRevisionsResponseSchema>;

export const layoutResponseSchema = z
  .object({
    layout: diagramLayoutSchema.nullable(),
    currentLayoutRevisionNo: layoutRevisionNoSchema,
  })
  .strict();
export type LayoutResponse = z.infer<typeof layoutResponseSchema>;

export const layoutMutationResponseSchema = z
  .object({
    state: layoutResponseSchema,
    layoutUpdated: z.boolean(),
  })
  .strict();
export type LayoutMutationResponse = z.infer<typeof layoutMutationResponseSchema>;

export const visualCommandMutationResponseSchema = z
  .object({
    state: projectStateSchema,
    revisionCreated: z.boolean(),
    layoutMigrated: z.boolean(),
    replayed: z.boolean(),
    appliedSchemaRevisionNo: schemaRevisionNoSchema,
    appliedLayoutRevisionNo: layoutRevisionNoSchema,
  })
  .strict();
export type VisualCommandMutationResponse = z.infer<typeof visualCommandMutationResponseSchema>;

export const errorResponseSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    correlationId: correlationIdSchema,
    currentRevisionNo: layoutRevisionNoSchema.optional(),
    diagnostics: z.array(diagnosticSchema).optional(),
    partialImpact: visualCommandPartialImpactSchema.optional(),
  })
  .strict();
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

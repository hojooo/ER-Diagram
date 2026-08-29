import { z } from "zod";

export const contractPackage = "@er-diagram/contracts";

export const primaryDialectSchema = z.enum(["POSTGRESQL", "MYSQL"]);
export type PrimaryDialect = z.infer<typeof primaryDialectSchema>;

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

export const createProjectRequestSchema = z.discriminatedUnion("operation", [
  createProjectOperationSchema,
  duplicateProjectOperationSchema,
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

export const sqlDataStatementHandlingSchema = z.enum(["REJECT", "CONFIRM_DDL_ONLY"]);
export type SqlDataStatementHandling = z.infer<typeof sqlDataStatementHandlingSchema>;

export const originalSqlRetentionModeSchema = z.enum(["DISCARD", "RETAIN"]);
export type OriginalSqlRetentionMode = z.infer<typeof originalSqlRetentionModeSchema>;

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

export const sqlImportArtifactEnvelopeSchema = z
  .object({
    previewVersion: z.literal(1),
    evidence: sqlImportPreviewEvidenceSchema,
    previewHash: sha256HexSchema,
    previewPolicy: sqlImportDataPolicyDecisionSchema,
    appliedPolicy: sqlImportDataPolicyDecisionSchema.nullable(),
    originalSqlRetention: originalSqlRetentionModeSchema,
  })
  .strict();
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

export const errorResponseSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    correlationId: correlationIdSchema,
    currentRevisionNo: layoutRevisionNoSchema.optional(),
    diagnostics: z.array(diagnosticSchema).optional(),
  })
  .strict();
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

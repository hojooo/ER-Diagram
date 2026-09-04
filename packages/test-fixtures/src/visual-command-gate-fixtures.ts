import { createHash } from "node:crypto";

export const VISUAL_COMMAND_GATE_FIXTURE_VERSION = 2 as const;

export type VisualCommandGateCommandKind =
  | "CREATE_TABLE"
  | "UPDATE_TABLE"
  | "RENAME_TABLE"
  | "DELETE_TABLE"
  | "CREATE_COLUMN"
  | "ALTER_COLUMN"
  | "DELETE_COLUMN"
  | "CREATE_REFERENCE"
  | "UPDATE_REFERENCE"
  | "DELETE_REFERENCE"
  | "CREATE_INDEX"
  | "UPDATE_INDEX"
  | "DELETE_INDEX"
  | "CREATE_CHECK"
  | "UPDATE_CHECK"
  | "DELETE_CHECK"
  | "UPDATE_GROUP_MEMBERSHIP"
  | "UPDATE_DIAGRAM_VIEW";

export type VisualCommandGateOutcome = "SUCCESS" | "NO_OP" | "FAILURE";

export interface VisualCommandGateSemanticSummary {
  readonly changeCount: number;
  readonly added: number;
  readonly updated: number;
  readonly deleted: number;
  readonly renameCandidates: number;
  readonly elementKinds: readonly string[];
}

export interface VisualCommandGateCase {
  readonly id: string;
  readonly outcome: VisualCommandGateOutcome;
  readonly command: Readonly<Record<string, unknown>>;
  readonly expectedDiagnosticCode: string | null;
  readonly beforeSourceHash: string;
  readonly afterSourceHash: string;
  readonly beforeSchemaHash: string;
  readonly afterSchemaHash: string;
  readonly semanticSummary: VisualCommandGateSemanticSummary;
}

export interface VisualCommandGateStep extends VisualCommandGateCase {
  readonly sequence: number;
  readonly outcome: "SUCCESS";
  readonly expectedDiagnosticCode: null;
}

export interface VisualCommandGateFixture {
  readonly id: string;
  readonly filepath: "/main.dbml";
  readonly initialSource: string;
  readonly initialSourceHash: string;
  readonly sentinels: readonly string[];
  readonly steps: readonly VisualCommandGateStep[];
  readonly noOpCases: readonly VisualCommandGateCase[];
  readonly failureCases: readonly VisualCommandGateCase[];
}

const INITIAL_SCHEMA_HASH = "646597546f59889a79a4e33d2b86f0eef5978be12c305e6bc8b381891088e049";
const EMPTY_SEMANTIC_SUMMARY: VisualCommandGateSemanticSummary = {
  changeCount: 0,
  added: 0,
  updated: 0,
  deleted: 0,
  renameCandidates: 0,
  elementKinds: [],
};

const USERS = key("table", "public", "users");
const USERS_ID = key("column", "public", "users", "id");
const USERS_SORT_ORDER = key("column", "public", "users", "sort_order");
const ACCOUNTS = key("table", "public", "accounts");
const ACCOUNTS_ID = key("column", "public", "accounts", "id");
const ACCOUNTS_BACKUP_USER_ID = key("column", "public", "accounts", "backup_user_id");
const RETIRED = key("table", "public", "retired");
const TRANSIENT = key("table", "public", "transient_audit");
const RENAMED_TRANSIENT = key("table", "public", "임시 감사 😀");
const CREATED_COLUMN = key("column", "public", "accounts", "sort_order");
const RENAMED_COLUMN = key("column", "public", "accounts", "display_order");
const CREATED_REFERENCE = key("reference", "public", "gate_backup_owner");
const CREATED_INDEX = key("index", "public", "accounts", "accounts_backup_idx");
const CREATED_CHECK = key("check", "public", "accounts", "accounts_id_positive");
const GROUP = key("group", "public", "identity 😀");
const VIEW = key("view", null, "focus 😀");
const INJECTED_CREATED_AT = key("column", "public", "accounts", "created_at");

const initialSource = [
  "// M3_GATE_COMMENT_SENTINEL: unrelated bytes stay exact.",
  'Project "M3 시각 편집 😀" {',
  '  database_type: "PostgreSQL"',
  '  Note: "M3_GATE_PROJECT_SENTINEL"',
  "}",
  "",
  "TablePartial audit_fields {",
  '  created_at timestamp [not null, provenance: "M3_GATE_PARTIAL_METADATA_SENTINEL"]',
  '  Note: "M3_GATE_PARTIAL_SENTINEL"',
  "}",
  "",
  'Table public.users [headercolor: #112233, owner: "M3_GATE_TABLE_METADATA_SENTINEL"] {',
  '  id bigint [pk, not null, note: "M3_GATE_COLUMN_NOTE_SENTINEL"]',
  "  email varchar [unique]",
  "  status varchar",
  "  sort_order integer",
  '  Note: "M3_GATE_USERS_NOTE_SENTINEL"',
  "}",
  "",
  "Table public.accounts {",
  "  ~audit_fields",
  "  id bigint [pk]",
  "  user_id bigint",
  "  backup_user_id bigint",
  "}",
  "",
  "Table public.retired {",
  "  id bigint [pk]",
  "}",
  "",
  'Table catalog."고객 😀" [fixture_marker: "M3_GATE_QUOTED_METADATA_SENTINEL"] {',
  '  "표시 이름" varchar [note: "M3_GATE_UNICODE_COLUMN_SENTINEL"]',
  "}",
  "",
  "Ref existing_owner: public.accounts.user_id > public.users.id",
  "",
  "// M3_GATE_GROUP_COMMENT_SENTINEL",
  'TableGroup "identity 😀" [color: #334455, team: "M3_GATE_GROUP_METADATA_SENTINEL"] {',
  "  public.users // M3_GATE_MEMBER_COMMENT_SENTINEL",
  "  public.retired",
  '  Note: "M3_GATE_GROUP_NOTE_SENTINEL"',
  "}",
  "",
  'DiagramView "focus 😀" {',
  "  // M3_GATE_VIEW_COMMENT_SENTINEL",
  "  Tables {",
  "    public.users",
  "    public.retired",
  "  }",
  "  TableGroups {",
  '    "identity 😀"',
  "  }",
  "  Schemas {",
  "    public",
  "    catalog",
  "  }",
  "}",
  "",
].join("\r\n");

const sentinels = [
  "M3_GATE_COMMENT_SENTINEL",
  "M3_GATE_PROJECT_SENTINEL",
  "M3_GATE_PARTIAL_METADATA_SENTINEL",
  "M3_GATE_PARTIAL_SENTINEL",
  "M3_GATE_TABLE_METADATA_SENTINEL",
  "M3_GATE_COLUMN_NOTE_SENTINEL",
  "M3_GATE_QUOTED_METADATA_SENTINEL",
  "M3_GATE_UNICODE_COLUMN_SENTINEL",
  "M3_GATE_GROUP_COMMENT_SENTINEL",
  "M3_GATE_MEMBER_COMMENT_SENTINEL",
  "M3_GATE_GROUP_METADATA_SENTINEL",
  "M3_GATE_GROUP_NOTE_SENTINEL",
  "M3_GATE_VIEW_COMMENT_SENTINEL",
] as const;

type StepEvidence = readonly [
  beforeSourceHash: string,
  afterSourceHash: string,
  beforeSchemaHash: string,
  afterSchemaHash: string,
  counts: readonly [
    changeCount: number,
    added: number,
    updated: number,
    deleted: number,
    renameCandidates: number,
  ],
  elementKinds: readonly string[],
];

const STEP_EVIDENCE: readonly StepEvidence[] = [
  [
    "e9906689103ecda57752f86f5ef70aee8bb0f7aa6f73dd2e1eeea714189b9252",
    "cc7d9ddd53417cb90e9a8d0fb6f404dcabeb837d0922332bb7cbbcc2e4de1dba",
    "646597546f59889a79a4e33d2b86f0eef5978be12c305e6bc8b381891088e049",
    "e2cf02bd23649e53db697435bd5a8a8efbc86f57e3c6fda3c434c914a6a68b9c",
    [2, 2, 0, 0, 0],
    ["column", "table"],
  ],
  [
    "cc7d9ddd53417cb90e9a8d0fb6f404dcabeb837d0922332bb7cbbcc2e4de1dba",
    "a968ddcdab15a0f90c768db81bfd3a3e3c41fa1f64b6afd027ab83619a5c87e6",
    "e2cf02bd23649e53db697435bd5a8a8efbc86f57e3c6fda3c434c914a6a68b9c",
    "7db6aa62e66bbfe1b03d2f6c2b13d944e4505f01504ef666249517ce00360c35",
    [1, 0, 1, 0, 0],
    ["table"],
  ],
  [
    "a968ddcdab15a0f90c768db81bfd3a3e3c41fa1f64b6afd027ab83619a5c87e6",
    "48c962dda70780179d6a62369d45a8ca4e8923aa73d03d86c9368710a30228ac",
    "7db6aa62e66bbfe1b03d2f6c2b13d944e4505f01504ef666249517ce00360c35",
    "d4a06f84757e2d37a57847ea19f108f8789fb42dbc4aef67cca7dbf51fb65427",
    [4, 2, 0, 2, 1],
    ["column", "table"],
  ],
  [
    "48c962dda70780179d6a62369d45a8ca4e8923aa73d03d86c9368710a30228ac",
    "004ba255d5a726d2ce154774fbf5222b3272c5838003fbcb60b3c1a0aa6ca7a1",
    "d4a06f84757e2d37a57847ea19f108f8789fb42dbc4aef67cca7dbf51fb65427",
    "8793fca4594e8900f6f551304d3a00efa76f9864ac58c36add9822c1fe35b9d9",
    [2, 1, 1, 0, 0],
    ["column", "table"],
  ],
  [
    "004ba255d5a726d2ce154774fbf5222b3272c5838003fbcb60b3c1a0aa6ca7a1",
    "026bce96bf39a0719868776ede1e099bfcb4dbf09a8898086e3ab8938e835c31",
    "8793fca4594e8900f6f551304d3a00efa76f9864ac58c36add9822c1fe35b9d9",
    "bb342152cdd51cfb87b8854f084442b44d2777999e99092042a9897a3415ad20",
    [1, 1, 0, 0, 0],
    ["reference"],
  ],
  [
    "026bce96bf39a0719868776ede1e099bfcb4dbf09a8898086e3ab8938e835c31",
    "23d48586d154dfed3910416cb6d0400a5549aff8f51a968334001653f35d8ace",
    "bb342152cdd51cfb87b8854f084442b44d2777999e99092042a9897a3415ad20",
    "9525eb40d4ab3c87323e0f22ce951273127f2e793e2dd4990a0e5ba454bc3833",
    [1, 1, 0, 0, 0],
    ["index"],
  ],
  [
    "23d48586d154dfed3910416cb6d0400a5549aff8f51a968334001653f35d8ace",
    "a49b87a4aff1c232c1b83238b8e26294733f3cd8a48bb141c73af2edbcfc37fe",
    "9525eb40d4ab3c87323e0f22ce951273127f2e793e2dd4990a0e5ba454bc3833",
    "2ff03f5ab9db13dac3726f4c1c7cf8532401271d4cc0d525b1f998786a31536e",
    [5, 1, 3, 1, 1],
    ["column", "index", "reference", "table"],
  ],
  [
    "a49b87a4aff1c232c1b83238b8e26294733f3cd8a48bb141c73af2edbcfc37fe",
    "d5766c368398864e84d024b014e2d45e1c11574a1c00699136e9938869491203",
    "2ff03f5ab9db13dac3726f4c1c7cf8532401271d4cc0d525b1f998786a31536e",
    "d8657067587424f0b1d6e3cb07d753d45a9fefbaff7dc9840fa9c3d4a79e3bba",
    [1, 0, 1, 0, 0],
    ["reference"],
  ],
  [
    "d5766c368398864e84d024b014e2d45e1c11574a1c00699136e9938869491203",
    "d2d128a4bf4b80de251c75d24b980c133ee5084e63b2fb197d7d27d9affd1f28",
    "d8657067587424f0b1d6e3cb07d753d45a9fefbaff7dc9840fa9c3d4a79e3bba",
    "1adee2d55cde399c060c8cd2ff014028a6c321ec416320f30d7988250ba52a06",
    [1, 0, 1, 0, 0],
    ["index"],
  ],
  [
    "d2d128a4bf4b80de251c75d24b980c133ee5084e63b2fb197d7d27d9affd1f28",
    "56e7eb0719b76f72f6296be374bfa823b5c76cbd89af14c58f4154369273e438",
    "1adee2d55cde399c060c8cd2ff014028a6c321ec416320f30d7988250ba52a06",
    "0fb83bf945f9122e7b25b1c53a1032551a837f95c1a2a584c890effb8e594767",
    [1, 1, 0, 0, 0],
    ["check"],
  ],
  [
    "56e7eb0719b76f72f6296be374bfa823b5c76cbd89af14c58f4154369273e438",
    "292490e779d9855ee4280f19edd331c576f8bc9f365a868115beabe50bcdd04f",
    "0fb83bf945f9122e7b25b1c53a1032551a837f95c1a2a584c890effb8e594767",
    "c9b606231b64823f5a520eefe70200a3cbb94b124e79548db1c99a41310f5f83",
    [1, 0, 1, 0, 0],
    ["check"],
  ],
  [
    "292490e779d9855ee4280f19edd331c576f8bc9f365a868115beabe50bcdd04f",
    "d6cf19756ded0fe3d61183ab67a19f4791513aacb6ddbe42a178dd779a88e290",
    "c9b606231b64823f5a520eefe70200a3cbb94b124e79548db1c99a41310f5f83",
    "1adee2d55cde399c060c8cd2ff014028a6c321ec416320f30d7988250ba52a06",
    [1, 0, 0, 1, 0],
    ["check"],
  ],
  [
    "d6cf19756ded0fe3d61183ab67a19f4791513aacb6ddbe42a178dd779a88e290",
    "70cbb58ebfc71ff548971512b3463590df8c630cf2886670d793930f7ac03471",
    "1adee2d55cde399c060c8cd2ff014028a6c321ec416320f30d7988250ba52a06",
    "0b58e3984849661d9cccdfaaab5f02291a9bc4f24eb9342bb24f972d2e5a246f",
    [1, 0, 0, 1, 0],
    ["reference"],
  ],
  [
    "70cbb58ebfc71ff548971512b3463590df8c630cf2886670d793930f7ac03471",
    "d8c6652058796ad384a510b333c0e0118fb2c7d95a6566ec1574bb8a1f10c7f6",
    "0b58e3984849661d9cccdfaaab5f02291a9bc4f24eb9342bb24f972d2e5a246f",
    "997f76e036e182f455788e4c98828aa7525b65c0af514860a21bf9b0a0e990b0",
    [1, 0, 0, 1, 0],
    ["index"],
  ],
  [
    "d8c6652058796ad384a510b333c0e0118fb2c7d95a6566ec1574bb8a1f10c7f6",
    "49210004e791177c1d2d2fa9fd27b6d097cc13d34a65f63a22e352e1ed262790",
    "997f76e036e182f455788e4c98828aa7525b65c0af514860a21bf9b0a0e990b0",
    "d4a06f84757e2d37a57847ea19f108f8789fb42dbc4aef67cca7dbf51fb65427",
    [2, 0, 1, 1, 0],
    ["column", "table"],
  ],
  [
    "49210004e791177c1d2d2fa9fd27b6d097cc13d34a65f63a22e352e1ed262790",
    "1bc489808616483a219aede5c189cfe56de5305f734a01758e36b51fd7b4ade1",
    "d4a06f84757e2d37a57847ea19f108f8789fb42dbc4aef67cca7dbf51fb65427",
    "488526f66b119974b50513a95064d4d98ee0b731fe98b09fe67aa039d11146db",
    [1, 0, 1, 0, 0],
    ["group"],
  ],
  [
    "1bc489808616483a219aede5c189cfe56de5305f734a01758e36b51fd7b4ade1",
    "5e67d74f80d90c4b45b0b5e0cb936e73d2b65cf699686136b27c40ea7f6630c8",
    "488526f66b119974b50513a95064d4d98ee0b731fe98b09fe67aa039d11146db",
    "7fdd2ea9e476cb68460ea6c70d41eeceec77a258053020265b0e4cef60a9706a",
    [1, 0, 1, 0, 0],
    ["view"],
  ],
  [
    "5e67d74f80d90c4b45b0b5e0cb936e73d2b65cf699686136b27c40ea7f6630c8",
    "5c8f32a67b0ebc419f5ddae2d0f4083e2992a0bbc34e56c95e978ec89735ae23",
    "7fdd2ea9e476cb68460ea6c70d41eeceec77a258053020265b0e4cef60a9706a",
    "07da7b74d5ca89a1dd9527b074e08330f015195ca237267f91e01c32919a512e",
    [2, 0, 0, 2, 0],
    ["column", "table"],
  ],
] as const;

const steps: readonly VisualCommandGateStep[] = [
  successStep(1, "create-table", {
    kind: "CREATE_TABLE",
    table: {
      schemaName: "public",
      name: "transient_audit",
      note: "M3 gate transient table",
      color: "#778899",
      columns: [column("id", "bigint", { primaryKey: true, notNull: true })],
    },
  }),
  successStep(2, "update-table", {
    kind: "UPDATE_TABLE",
    targetTableKey: TRANSIENT,
    changes: { note: "M3 gate updated transient table", color: "#AABBCC" },
  }),
  successStep(3, "rename-table", {
    kind: "RENAME_TABLE",
    targetTableKey: TRANSIENT,
    newName: "임시 감사 😀",
  }),
  successStep(4, "create-column", {
    kind: "CREATE_COLUMN",
    targetTableKey: ACCOUNTS,
    column: column("sort_order", "integer", {
      default: { type: "number", value: 0 },
      note: "M3 gate sort order",
    }),
  }),
  successStep(5, "create-reference", {
    kind: "CREATE_REFERENCE",
    reference: {
      schemaName: "public",
      name: "gate_backup_owner",
      endpoints: [
        {
          tableKey: ACCOUNTS,
          columnKeys: [ACCOUNTS_BACKUP_USER_ID, CREATED_COLUMN],
          multiplicity: { min: 0, max: null },
        },
        {
          tableKey: USERS,
          columnKeys: [USERS_ID, USERS_SORT_ORDER],
          multiplicity: { min: 1, max: 1 },
        },
      ],
      onDelete: null,
      onUpdate: null,
      color: null,
      inactive: false,
    },
  }),
  successStep(6, "create-index", {
    kind: "CREATE_INDEX",
    targetTableKey: ACCOUNTS,
    index: {
      name: "accounts_backup_idx",
      terms: [
        { kind: "COLUMN", columnKey: ACCOUNTS_BACKUP_USER_ID },
        { kind: "COLUMN", columnKey: CREATED_COLUMN },
      ],
      type: null,
      unique: false,
      primaryKey: false,
      note: "M3 gate index",
    },
  }),
  successStep(7, "alter-column", {
    kind: "ALTER_COLUMN",
    targetTableKey: ACCOUNTS,
    targetColumnKey: CREATED_COLUMN,
    newName: "display_order",
    changes: { notNull: true, note: "M3 gate updated sort order" },
    beforeColumnKey: ACCOUNTS_ID,
  }),
  successStep(8, "update-reference", {
    kind: "UPDATE_REFERENCE",
    targetReferenceKey: CREATED_REFERENCE,
    changes: { onDelete: "cascade", onUpdate: "restrict", color: "#445566" },
  }),
  successStep(9, "update-index", {
    kind: "UPDATE_INDEX",
    targetTableKey: ACCOUNTS,
    targetIndexKey: CREATED_INDEX,
    changes: { unique: true, note: "M3 gate updated index" },
  }),
  successStep(10, "create-check", {
    kind: "CREATE_CHECK",
    targetTableKey: ACCOUNTS,
    ownerColumnKey: null,
    check: { name: "accounts_id_positive", expression: "id > 0" },
  }),
  successStep(11, "update-check", {
    kind: "UPDATE_CHECK",
    targetTableKey: ACCOUNTS,
    ownerColumnKey: null,
    targetCheckKey: CREATED_CHECK,
    changes: { expression: "id >= 0" },
  }),
  successStep(12, "delete-check", {
    kind: "DELETE_CHECK",
    targetTableKey: ACCOUNTS,
    ownerColumnKey: null,
    targetCheckKey: CREATED_CHECK,
  }),
  successStep(13, "delete-reference", {
    kind: "DELETE_REFERENCE",
    targetReferenceKey: CREATED_REFERENCE,
  }),
  successStep(14, "delete-index", {
    kind: "DELETE_INDEX",
    targetTableKey: ACCOUNTS,
    targetIndexKey: CREATED_INDEX,
  }),
  successStep(15, "delete-column", {
    kind: "DELETE_COLUMN",
    targetTableKey: ACCOUNTS,
    targetColumnKey: RENAMED_COLUMN,
  }),
  successStep(16, "update-group-membership", {
    kind: "UPDATE_GROUP_MEMBERSHIP",
    targetGroupKey: GROUP,
    addTableKeys: [RENAMED_TRANSIENT],
    removeTableKeys: [RETIRED],
  }),
  successStep(17, "update-diagram-view", {
    kind: "UPDATE_DIAGRAM_VIEW",
    targetViewKey: VIEW,
    changes: { visibleTableKeys: [USERS, RENAMED_TRANSIENT] },
  }),
  successStep(18, "delete-table", {
    kind: "DELETE_TABLE",
    targetTableKey: RETIRED,
  }),
];

const noOpCases: readonly VisualCommandGateCase[] = [
  standaloneCase("update-table-semantic-no-op", "NO_OP", {
    kind: "UPDATE_TABLE",
    targetTableKey: USERS,
    changes: { note: "M3_GATE_USERS_NOTE_SENTINEL", color: "#112233" },
  }),
];

const failureCases: readonly VisualCommandGateCase[] = [
  standaloneCase(
    "create-column-reparse-rollback",
    "FAILURE",
    {
      kind: "CREATE_COLUMN",
      targetTableKey: ACCOUNTS,
      column: column("broken_type", "varchar("),
    },
    "VISUAL_REPARSE_FAILED",
  ),
  standaloneCase(
    "delete-table-dependency-rollback",
    "FAILURE",
    { kind: "DELETE_TABLE", targetTableKey: RETIRED },
    "VISUAL_DEPENDENCY_CONFLICT",
  ),
  standaloneCase(
    "partial-column-protection-rollback",
    "FAILURE",
    {
      kind: "DELETE_COLUMN",
      targetTableKey: ACCOUNTS,
      targetColumnKey: INJECTED_CREATED_AT,
    },
    "VISUAL_PARTIAL_TARGET_PROTECTED",
  ),
  standaloneCase(
    "strict-membership-conflict-rollback",
    "FAILURE",
    {
      kind: "UPDATE_GROUP_MEMBERSHIP",
      targetGroupKey: GROUP,
      addTableKeys: [USERS],
      removeTableKeys: [],
    },
    "VISUAL_MEMBERSHIP_CONFLICT",
  ),
];

export const visualCommandGateFixture: VisualCommandGateFixture = {
  id: "m3-visual-command-gate",
  filepath: "/main.dbml",
  initialSource,
  initialSourceHash: sha256(initialSource),
  sentinels,
  steps,
  noOpCases,
  failureCases,
};

export const VISUAL_COMMAND_GATE_FIXTURE_SET_HASH = sha256(
  JSON.stringify(visualCommandGateFixture),
);

function successStep(
  sequence: number,
  id: string,
  command: Readonly<Record<string, unknown>>,
): VisualCommandGateStep {
  const evidence = STEP_EVIDENCE[sequence - 1];
  if (!evidence) throw new Error(`Missing visual command gate evidence for step ${sequence}.`);
  const [beforeSourceHash, afterSourceHash, beforeSchemaHash, afterSchemaHash, counts, kinds] =
    evidence;
  const [changeCount, added, updated, deleted, renameCandidates] = counts;
  return {
    sequence,
    id,
    outcome: "SUCCESS",
    command: commandEnvelope(sequence, sequence, command),
    expectedDiagnosticCode: null,
    beforeSourceHash,
    afterSourceHash,
    beforeSchemaHash,
    afterSchemaHash,
    semanticSummary: {
      changeCount,
      added,
      updated,
      deleted,
      renameCandidates,
      elementKinds: kinds,
    },
  };
}

function standaloneCase(
  id: string,
  outcome: "NO_OP" | "FAILURE",
  command: Readonly<Record<string, unknown>>,
  expectedDiagnosticCode: string | null = null,
): VisualCommandGateCase {
  return {
    id,
    outcome,
    command: commandEnvelope(100 + noOpCasesAndFailuresSequence(id), 1, command),
    expectedDiagnosticCode,
    beforeSourceHash: sha256(initialSource),
    afterSourceHash: sha256(initialSource),
    beforeSchemaHash: INITIAL_SCHEMA_HASH,
    afterSchemaHash: INITIAL_SCHEMA_HASH,
    semanticSummary: EMPTY_SEMANTIC_SUMMARY,
  };
}

function commandEnvelope(
  sequence: number,
  expectedSchemaRevisionNo: number,
  command: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    commandId: `123e4567-e89b-42d3-a456-${(426_614_174_000 + sequence).toString().padStart(12, "0")}`,
    expectedSchemaRevisionNo,
    ...command,
  };
}

function noOpCasesAndFailuresSequence(id: string): number {
  const ids = [
    "update-table-semantic-no-op",
    "create-column-reparse-rollback",
    "delete-table-dependency-rollback",
    "partial-column-protection-rollback",
    "strict-membership-conflict-rollback",
  ];
  const index = ids.indexOf(id);
  if (index < 0) throw new Error(`Unknown visual command gate case: ${id}`);
  return index + 1;
}

function column(
  name: string,
  type: string,
  overrides: Partial<{
    primaryKey: boolean;
    unique: boolean;
    notNull: boolean;
    default: Readonly<Record<string, unknown>> | null;
    increment: boolean;
    note: string | null;
  }> = {},
): Readonly<Record<string, unknown>> {
  return {
    name,
    type,
    primaryKey: false,
    unique: false,
    notNull: false,
    default: null,
    increment: false,
    note: null,
    ...overrides,
  };
}

function key(kind: string, ...segments: unknown[]): string {
  return `${kind}:${JSON.stringify(segments)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

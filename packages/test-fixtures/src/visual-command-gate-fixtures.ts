import { createHash } from "node:crypto";

export const VISUAL_COMMAND_GATE_FIXTURE_VERSION = 1 as const;

export type VisualCommandGateCommandKind =
  | "CREATE_TABLE"
  | "UPDATE_TABLE"
  | "RENAME_TABLE"
  | "DELETE_TABLE"
  | "CREATE_COLUMN"
  | "UPDATE_COLUMN"
  | "RENAME_COLUMN"
  | "REORDER_COLUMN"
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
    INITIAL_SCHEMA_HASH,
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
    "d900047d69ea4e0eeb6518ad4822182534a8eb77b966da4fc1da65a06c5e46eb",
    "8793fca4594e8900f6f551304d3a00efa76f9864ac58c36add9822c1fe35b9d9",
    "41affe81a970a006c262e4d0582cc62570dc9d1419c25f39e82fb253dd9f1e1e",
    [1, 0, 1, 0, 0],
    ["column"],
  ],
  [
    "d900047d69ea4e0eeb6518ad4822182534a8eb77b966da4fc1da65a06c5e46eb",
    "77f79d543e9771593be4c5ce350f361b6ae121c18d8acafb63043351e4a1533c",
    "41affe81a970a006c262e4d0582cc62570dc9d1419c25f39e82fb253dd9f1e1e",
    "dab26fd0c78cd7ba541c34903c987cdccf36609885a311d5cb500126e0a3cda4",
    [1, 1, 0, 0, 0],
    ["reference"],
  ],
  [
    "77f79d543e9771593be4c5ce350f361b6ae121c18d8acafb63043351e4a1533c",
    "029bdfa0c669e5216f0ebe8b7fa823db5604be5003a78f67cf052309a1a336b1",
    "dab26fd0c78cd7ba541c34903c987cdccf36609885a311d5cb500126e0a3cda4",
    "c37756b4bde132b7ff16ff45e8080215f9312a4d7794829933df5b4b57c69792",
    [1, 1, 0, 0, 0],
    ["index"],
  ],
  [
    "029bdfa0c669e5216f0ebe8b7fa823db5604be5003a78f67cf052309a1a336b1",
    "ca870352ddb8f0946123e4978374ef24321a6e2a5bbb7b929c2278c2bbe4f5da",
    "c37756b4bde132b7ff16ff45e8080215f9312a4d7794829933df5b4b57c69792",
    "97fa7ece62722936ae5e7e1108458f0efec0c03c4cb0560a02c86e90e09f87bd",
    [5, 1, 3, 1, 1],
    ["column", "index", "reference", "table"],
  ],
  [
    "ca870352ddb8f0946123e4978374ef24321a6e2a5bbb7b929c2278c2bbe4f5da",
    "83505af82bd3defc6138414118426ae4c4f3633c2e6f9a0b895a6af4b64f98c6",
    "97fa7ece62722936ae5e7e1108458f0efec0c03c4cb0560a02c86e90e09f87bd",
    "9202fed4975c71b063866e3e7b19a54e637e027cde3a4f1e32eefd534b917d44",
    [1, 0, 1, 0, 0],
    ["reference"],
  ],
  [
    "83505af82bd3defc6138414118426ae4c4f3633c2e6f9a0b895a6af4b64f98c6",
    "effe2aa75a8697617e372b8a9e071c4c2a35f819cce14cd05e3e46784db0413e",
    "9202fed4975c71b063866e3e7b19a54e637e027cde3a4f1e32eefd534b917d44",
    "52083c9ebcbfddf5d3c82052057b7b2677dc60545b8bd0ee5c857c961647f877",
    [1, 0, 1, 0, 0],
    ["index"],
  ],
  [
    "effe2aa75a8697617e372b8a9e071c4c2a35f819cce14cd05e3e46784db0413e",
    "1fe5560ebc92be4b8cd235f6987365468cfca220a15d0f0b81052446b922766c",
    "52083c9ebcbfddf5d3c82052057b7b2677dc60545b8bd0ee5c857c961647f877",
    "f9c3ce80c15b1593778c73b27738d5ea7408c4eca290d61eab5a3ced241921fd",
    [1, 1, 0, 0, 0],
    ["check"],
  ],
  [
    "1fe5560ebc92be4b8cd235f6987365468cfca220a15d0f0b81052446b922766c",
    "f648427abdc5e1068424f9644a2711c3bb2a8d33b0daad9ac82ce8c28b10a51b",
    "f9c3ce80c15b1593778c73b27738d5ea7408c4eca290d61eab5a3ced241921fd",
    "661c60511867b06cc95b708b8d8a9c5816add4315a754cfc5e9a8a402a9ccb08",
    [1, 0, 1, 0, 0],
    ["check"],
  ],
  [
    "f648427abdc5e1068424f9644a2711c3bb2a8d33b0daad9ac82ce8c28b10a51b",
    "4e1a8095bf04ea91c76eccb0ce3a4bd65c2e2f2c4ddee0aa349b0d5bd3431abc",
    "661c60511867b06cc95b708b8d8a9c5816add4315a754cfc5e9a8a402a9ccb08",
    "52083c9ebcbfddf5d3c82052057b7b2677dc60545b8bd0ee5c857c961647f877",
    [1, 0, 0, 1, 0],
    ["check"],
  ],
  [
    "4e1a8095bf04ea91c76eccb0ce3a4bd65c2e2f2c4ddee0aa349b0d5bd3431abc",
    "134ded761caa563518a920b3cc32cfc35811f9b43dee69347b744c64ff7d7006",
    "52083c9ebcbfddf5d3c82052057b7b2677dc60545b8bd0ee5c857c961647f877",
    "e5c5da8cd38c42c2b48d7815a3ced19aae4e699a4812ddea9a430facc5c50da5",
    [1, 0, 0, 1, 0],
    ["reference"],
  ],
  [
    "134ded761caa563518a920b3cc32cfc35811f9b43dee69347b744c64ff7d7006",
    "6045a6eda4aacb743d5293962ab2d97638f1e4677fbf6198236a237c42591211",
    "e5c5da8cd38c42c2b48d7815a3ced19aae4e699a4812ddea9a430facc5c50da5",
    "03805e818de0b8df435d8b82784633ca981b817a7d98fcf8f3c41ee90228dffc",
    [1, 0, 0, 1, 0],
    ["index"],
  ],
  [
    "6045a6eda4aacb743d5293962ab2d97638f1e4677fbf6198236a237c42591211",
    "d8c6652058796ad384a510b333c0e0118fb2c7d95a6566ec1574bb8a1f10c7f6",
    "03805e818de0b8df435d8b82784633ca981b817a7d98fcf8f3c41ee90228dffc",
    "997f76e036e182f455788e4c98828aa7525b65c0af514860a21bf9b0a0e990b0",
    [1, 0, 1, 0, 0],
    ["table"],
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
];

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
  successStep(5, "update-column", {
    kind: "UPDATE_COLUMN",
    targetTableKey: ACCOUNTS,
    targetColumnKey: CREATED_COLUMN,
    changes: { notNull: true, note: "M3 gate updated sort order" },
  }),
  successStep(6, "create-reference", {
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
  successStep(7, "create-index", {
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
  successStep(8, "rename-column", {
    kind: "RENAME_COLUMN",
    targetTableKey: ACCOUNTS,
    targetColumnKey: CREATED_COLUMN,
    newName: "display_order",
  }),
  successStep(9, "update-reference", {
    kind: "UPDATE_REFERENCE",
    targetReferenceKey: CREATED_REFERENCE,
    changes: { onDelete: "cascade", onUpdate: "restrict", color: "#445566" },
  }),
  successStep(10, "update-index", {
    kind: "UPDATE_INDEX",
    targetTableKey: ACCOUNTS,
    targetIndexKey: CREATED_INDEX,
    changes: { unique: true, note: "M3 gate updated index" },
  }),
  successStep(11, "create-check", {
    kind: "CREATE_CHECK",
    targetTableKey: ACCOUNTS,
    ownerColumnKey: null,
    check: { name: "accounts_id_positive", expression: "id > 0" },
  }),
  successStep(12, "update-check", {
    kind: "UPDATE_CHECK",
    targetTableKey: ACCOUNTS,
    ownerColumnKey: null,
    targetCheckKey: CREATED_CHECK,
    changes: { expression: "id >= 0" },
  }),
  successStep(13, "delete-check", {
    kind: "DELETE_CHECK",
    targetTableKey: ACCOUNTS,
    ownerColumnKey: null,
    targetCheckKey: CREATED_CHECK,
  }),
  successStep(14, "delete-reference", {
    kind: "DELETE_REFERENCE",
    targetReferenceKey: CREATED_REFERENCE,
  }),
  successStep(15, "delete-index", {
    kind: "DELETE_INDEX",
    targetTableKey: ACCOUNTS,
    targetIndexKey: CREATED_INDEX,
  }),
  successStep(16, "reorder-column", {
    kind: "REORDER_COLUMN",
    targetTableKey: ACCOUNTS,
    targetColumnKey: RENAMED_COLUMN,
    beforeColumnKey: ACCOUNTS_ID,
  }),
  successStep(17, "delete-column", {
    kind: "DELETE_COLUMN",
    targetTableKey: ACCOUNTS,
    targetColumnKey: RENAMED_COLUMN,
  }),
  successStep(18, "update-group-membership", {
    kind: "UPDATE_GROUP_MEMBERSHIP",
    targetGroupKey: GROUP,
    addTableKeys: [RENAMED_TRANSIENT],
    removeTableKeys: [RETIRED],
  }),
  successStep(19, "update-diagram-view", {
    kind: "UPDATE_DIAGRAM_VIEW",
    targetViewKey: VIEW,
    changes: { visibleTableKeys: [USERS, RENAMED_TRANSIENT] },
  }),
  successStep(20, "delete-table", {
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

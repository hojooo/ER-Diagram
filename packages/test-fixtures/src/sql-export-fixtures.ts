import { createHash } from "node:crypto";

import type { SqlFixtureDialect } from "./sql-capability-fixtures.js";

export const SQL_EXPORT_FIXTURE_VERSION = 1 as const;

export type SqlExportFixtureStatus = "EXACT" | "NORMALIZED" | "PARTIAL" | "UNSUPPORTED" | "ERROR";

export interface SqlExportFixture {
  readonly id: string;
  readonly dialect: SqlFixtureDialect;
  readonly source: string;
  readonly sourceHash: string;
  readonly hasPersistedLayout: boolean;
  readonly expectedOverallStatus: SqlExportFixtureStatus;
  readonly expectedEntryCodes: readonly string[];
  readonly expectedGeneratedSqlHash: string | null;
  readonly expectedExportableSchemaHash: string | null;
}

const OUTPUT_HASHES: Readonly<
  Record<
    string,
    {
      readonly generatedSql: string | null;
      readonly exportableSchema: string | null;
    }
  >
> = {
  "mysql-basic": {
    generatedSql: "d7748f462edef552f88fbf3d4d756f3c1370d5e19b87b57d4ed5432867f9acf9",
    exportableSchema: "28ed51b447ad69fd699e6a07f1640834b196e84b2aa26540c0c5fd28038871b1",
  },
  "mysql-custom-type-error": {
    generatedSql: null,
    exportableSchema: null,
  },
  "mysql-enum-and-table-comment": {
    generatedSql: "68cceb65ce74f489cc79d60363248377d44a45786b05fe81f1eae1cc77843b27",
    exportableSchema: "26b46f9526e2d5875ee538188b234ed9779c23524be6d6e1d872c35999e891b6",
  },
  "postgresql-basic": {
    generatedSql: "6bef785af02539128ce885b75710ac0362e547e39c93138c93b9d0145f866fc7",
    exportableSchema: "7598adda74fea0906e8cd957425b89dda101b63a9cdaf76b2059a1a42b99a3e6",
  },
  "postgresql-dbml-only-and-records": {
    generatedSql: "2d32042ca2571a67421752ef6f796e217d8c398dc3f028fe4a1c370f9697d95c",
    exportableSchema: "9d8e91f674ca40d24d0d63ab2dd4b6cb1bc0af52bf872ff38dcfb65facc26252",
  },
  "postgresql-empty": {
    generatedSql: "360b279f5f086329fa17a84e4a9a553e63bca128e3b0ceee54a0a1adaba67a23",
    exportableSchema: "2a78bace37aa230cf88916a33af0375c37685cc7b3126badfa63f6073d0d0be6",
  },
  "postgresql-enum-array": {
    generatedSql: "3c36bcba28b4e8b89be5f39c5ea279c701e7142cb8100334783c10e49a58f873",
    exportableSchema: "2c13ec0c5296932bbfc2ffb2864b95a6026816d887689f96e7b42c005331ff32",
  },
  "postgresql-many-to-many": {
    generatedSql: "1a57a01d8bb4445a10dc702c18dd04e4b24b67a392806a070bf78da48bf010ca",
    exportableSchema: "b898112b61d6960cec4a297bed9fafe6cf7c84c8a5179918d5a484544cd754da",
  },
  "postgresql-partial-and-custom-type": {
    generatedSql: "b504c34bb5bf6e15ac1b2205f11dd4fd4ce945ed756a413e59f5aa42a5b00be6",
    exportableSchema: "9a7aeb6dab6ebf1be4184986a8747ef77bba5dd25837b751375647c607170dac",
  },
};

export const sqlExportFixtures: readonly SqlExportFixture[] = [
  fixture({
    id: "mysql-basic",
    dialect: "MYSQL",
    source: `Table app.accounts {
  id bigint [pk, increment]
  email varchar(255) [not null, unique]
  enabled boolean [not null, default: true]
}
`,
    hasPersistedLayout: false,
    expectedOverallStatus: "EXACT",
    expectedEntryCodes: [],
  }),
  fixture({
    id: "mysql-custom-type-error",
    dialect: "MYSQL",
    source: `Table app.measurements {
  id bigint [pk]
  sample custom_measurement
}
`,
    hasPersistedLayout: false,
    expectedOverallStatus: "ERROR",
    expectedEntryCodes: ["SQL_EXPORT_UNSUPPORTED_CUSTOM_TYPE"],
  }),
  fixture({
    id: "mysql-enum-and-table-comment",
    dialect: "MYSQL",
    source: `Enum app.account_status {
  active
  disabled
}

Table app.accounts {
  id bigint [pk]
  status app.account_status [not null]
  label varchar(80) [note: 'Column comment']

  Note: 'Pinned MySQL table comment gap'
}
`,
    hasPersistedLayout: false,
    expectedOverallStatus: "PARTIAL",
    expectedEntryCodes: [
      "SQL_EXPORT_NORMALIZES_MYSQL_ENUM",
      "SQL_EXPORT_PARTIAL_MYSQL_TABLE_COMMENT",
    ],
  }),
  fixture({
    id: "postgresql-basic",
    dialect: "POSTGRESQL",
    source:
      `Enum app.account_status {
  active
  disabled
}

Table app.accounts {
  tenant_id bigint [not null]
  id bigint [not null]
  status app.account_status [not null, default: 'active']
  email varchar(255) [not null, unique, note: 'Email address']

  indexes {
    (tenant_id, id) [pk]
    (` +
      "`lower(email)`" +
      `) [name: 'accounts_email_lower_idx']
  }

  checks {
    ` +
      "`length(email) > 3`" +
      ` [name: 'accounts_email_length']
  }

  Note: 'Account table'
}
`,
    hasPersistedLayout: false,
    expectedOverallStatus: "NORMALIZED",
    expectedEntryCodes: ["SQL_EXPORT_NORMALIZES_SQL_SYNTAX"],
  }),
  fixture({
    id: "postgresql-dbml-only-and-records",
    dialect: "POSTGRESQL",
    source: `Project export_fixture {
  database_type: 'PostgreSQL'
  Note: 'Project-only note'
}

Note export_note [color: #445566, owner: 'fixture'] {
  'Sticky-only note'
}

Table app.parents [headercolor: #112233, owner: 'fixture'] {
  id bigint [pk]
}

Table app.children {
  id bigint [pk]
  parent_id bigint
  profile_id bigint

  Records {
    1, 1, 1
  }
}

Ref active_parent: app.children.parent_id > app.parents.id
Ref one_to_one: app.children.profile_id - app.parents.id
Ref inactive_link: app.children.id - app.parents.id [inactive]

TableGroup export_group [color: #778899] {
  app.parents
  app.children
}

DiagramView export_view {
  Tables {
    app.parents
    app.children
  }
  Notes {
    export_note
  }
  TableGroups {
    export_group
  }
  Schemas {
    app
  }
}
`,
    hasPersistedLayout: true,
    expectedOverallStatus: "PARTIAL",
    expectedEntryCodes: [
      "SQL_EXPORT_OMITS_DIAGRAM_VIEW",
      "SQL_EXPORT_OMITS_ENRICHMENT",
      "SQL_EXPORT_OMITS_INACTIVE_REFERENCE",
      "SQL_EXPORT_OMITS_LAYOUT",
      "SQL_EXPORT_OMITS_PROJECT",
      "SQL_EXPORT_OMITS_RECORDS",
      "SQL_EXPORT_OMITS_STICKY_NOTE",
      "SQL_EXPORT_OMITS_TABLE_GROUP",
      "SQL_EXPORT_PARTIAL_CARDINALITY",
    ],
  }),
  fixture({
    id: "postgresql-empty",
    dialect: "POSTGRESQL",
    source: "// intentionally empty valid schema\n",
    hasPersistedLayout: false,
    expectedOverallStatus: "EXACT",
    expectedEntryCodes: [],
  }),
  fixture({
    id: "postgresql-enum-array",
    dialect: "POSTGRESQL",
    source: `Enum app.mood {
  happy
  sad
}

Table app.events {
  id bigint [pk]
  moods app.mood[]
}
`,
    hasPersistedLayout: false,
    expectedOverallStatus: "PARTIAL",
    expectedEntryCodes: ["SQL_EXPORT_PARTIAL_POSTGRESQL_ENUM_ARRAY"],
  }),
  fixture({
    id: "postgresql-many-to-many",
    dialect: "POSTGRESQL",
    source: `Table app.authors {
  id bigint [pk]
}

Table app.books {
  id bigint [pk]
}

Ref author_books: app.authors.id <> app.books.id
`,
    hasPersistedLayout: false,
    expectedOverallStatus: "NORMALIZED",
    expectedEntryCodes: ["SQL_EXPORT_NORMALIZES_MANY_TO_MANY"],
  }),
  fixture({
    id: "postgresql-partial-and-custom-type",
    dialect: "POSTGRESQL",
    source:
      `TablePartial audit_fields {
  created_at timestamp [not null, default: ` +
      "`now()`" +
      `]
}

Table app.documents as docs {
  ~audit_fields
  id bigint [pk]
  content citext
}
`,
    hasPersistedLayout: false,
    expectedOverallStatus: "UNSUPPORTED",
    expectedEntryCodes: [
      "SQL_EXPORT_MATERIALIZES_TABLE_PARTIAL",
      "SQL_EXPORT_NORMALIZES_TABLE_ALIAS",
      "SQL_EXPORT_UNSUPPORTED_CUSTOM_TYPE",
    ],
  }),
].sort((left, right) => compareCodeUnits(left.id, right.id));

export const SQL_EXPORT_FIXTURE_SET_HASH = sha256(
  JSON.stringify({
    version: SQL_EXPORT_FIXTURE_VERSION,
    fixtures: sqlExportFixtures,
  }),
);

function fixture(
  input: Omit<
    SqlExportFixture,
    "expectedExportableSchemaHash" | "expectedGeneratedSqlHash" | "sourceHash"
  >,
): SqlExportFixture {
  const output = OUTPUT_HASHES[input.id];
  if (!output) throw new Error(`Missing SQL export output fixture: ${input.id}`);
  return {
    ...input,
    sourceHash: sha256(input.source),
    expectedGeneratedSqlHash: output.generatedSql,
    expectedExportableSchemaHash: output.exportableSchema,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const PROJECT_BUNDLE_FIXTURE_VERSION = 1 as const;

export interface ProjectBundleFixture {
  readonly id: "portable-project-v1";
  readonly sourceProjectId: string;
  readonly name: string;
  readonly primaryDialect: "POSTGRESQL";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly current: {
    readonly revisionNo: 3;
    readonly source: string;
    readonly sourceHash: string;
    readonly validity: "INVALID";
  };
  readonly lastValid: {
    readonly revisionNo: 1;
    readonly source: string;
    readonly sourceHash: string;
    readonly validity: "VALID";
  };
  readonly layout: {
    readonly viewKey: "GLOBAL";
    readonly revisionNo: 4;
    readonly tableKey: string;
  };
  readonly retainedSql: string;
  readonly retainedSqlHash: string;
  readonly rowSentinel: string;
}

const LAST_VALID_SOURCE = [
  'Table "고객 🚀" {',
  "  id bigint [pk]",
  "  email varchar [unique]",
  "}",
  "",
].join("\r\n");
const CURRENT_SOURCE = `${LAST_VALID_SOURCE}Table broken {\r\n`;
const ROW_SENTINEL = "PRIVATE_ROW_SENTINEL_M4_003";
const RETAINED_SQL = [
  "CREATE TABLE customers (id bigint PRIMARY KEY);",
  `INSERT INTO customers VALUES ('${ROW_SENTINEL}');`,
  "",
].join("\r\n");

export const projectBundleFixture: ProjectBundleFixture = {
  id: "portable-project-v1",
  sourceProjectId: "018f0f87-7b5a-7cc0-8000-000000000001",
  name: "Portable 고객 🚀",
  primaryDialect: "POSTGRESQL",
  createdAt: "2026-08-31T01:02:03.000Z",
  updatedAt: "2026-08-31T04:05:06.000Z",
  current: {
    revisionNo: 3,
    source: CURRENT_SOURCE,
    sourceHash: "92090b99b58d5cbe840e8ae2125f004124e6ca89fbb3a4e27569ecad2e8c57a8",
    validity: "INVALID",
  },
  lastValid: {
    revisionNo: 1,
    source: LAST_VALID_SOURCE,
    sourceHash: "35f92399c01127c1565174aa9b628c3cdc9c5142956f294e6ce09a3d01be10c9",
    validity: "VALID",
  },
  layout: {
    viewKey: "GLOBAL",
    revisionNo: 4,
    tableKey: 'table:["public","고객 🚀"]',
  },
  retainedSql: RETAINED_SQL,
  retainedSqlHash: "a5638119affd6f289d9a5c9ef76fb912d75f4510b89d959f6b3bd575ddf8e30f",
  rowSentinel: ROW_SENTINEL,
};

export const PROJECT_BUNDLE_FIXTURE_SET_HASH =
  "0abc70cfca887f96c355738bcdd78d2755862ec309d752ccc5e527342862c77e";

import { createHash } from "node:crypto";

export const SQL_CAPABILITY_FIXTURE_VERSION = 1 as const;

export type SqlFixtureDialect = "POSTGRESQL" | "MYSQL";

export type SqlFixtureCapabilityStatus =
  | "EXACT"
  | "NORMALIZED"
  | "PARTIAL"
  | "UNSUPPORTED"
  | "NOT_APPLICABLE";

export type SqlFixtureObservedOutcome =
  | "PRESERVED"
  | "NORMALIZED"
  | "PARTIALLY_PRESERVED"
  | "DROPPED"
  | "REJECTED"
  | "EMITS_RECORDS"
  | "NOT_APPLICABLE";

export type SqlFixtureCapabilityId =
  | "ALTER_ADD_FOREIGN_KEY"
  | "ALTER_ADD_UNIQUE"
  | "ALTER_COLUMN_MUTATION"
  | "ARRAY_BUILTIN"
  | "ARRAY_SCHEMA_ENUM"
  | "AUTO_INCREMENT"
  | "BASIC_CONSTRAINTS"
  | "COMMENTS"
  | "COMPOSITE_KEYS"
  | "COPY_DATA"
  | "CREATE_TABLE"
  | "DML"
  | "DROP_STATEMENT"
  | "ENUM"
  | "FOREIGN_KEY_ACTIONS"
  | "FUNCTION_INDEX"
  | "GENERATED_COLUMN"
  | "IDENTITY"
  | "INDEX_METHODS"
  | "MYSQL_INDEXES"
  | "MYSQL_TABLE_OPTIONS"
  | "PARTIAL_INDEX"
  | "PROCEDURE_OR_FUNCTION_BODY"
  | "SCHEMA_QUALIFIED_TABLE"
  | "SERIAL"
  | "TABLESPACE"
  | "TRIGGER"
  | "VIEW";

export interface SqlFixtureInventory {
  readonly tables: number;
  readonly enums: number;
  readonly references: number;
}

export interface SqlCapabilityFixture {
  readonly id: string;
  readonly capabilityId: SqlFixtureCapabilityId;
  readonly dialect: SqlFixtureDialect;
  readonly source: string;
  readonly sourceHash: string;
  readonly targetStatus: SqlFixtureCapabilityStatus;
  readonly observedStatus: SqlFixtureCapabilityStatus;
  readonly observedOutcome: SqlFixtureObservedOutcome;
  readonly expectedGeneratedDbmlHash: string;
  readonly expectedSchemaHash: string;
  readonly expectedInventory: SqlFixtureInventory;
  readonly preservedDbmlFragments: readonly string[];
  readonly droppedDbmlFragments: readonly string[];
}

export interface SqlParserErrorFixture {
  readonly id: string;
  readonly dialect: SqlFixtureDialect;
  readonly source: string;
  readonly sourceHash: string;
  readonly expectedError: {
    readonly messageIncludes: string;
    readonly startLine: number;
    readonly startColumn: number;
  };
}

interface FixtureInput {
  readonly id: string;
  readonly capabilityId: SqlFixtureCapabilityId;
  readonly dialect: SqlFixtureDialect;
  readonly source: string;
  readonly targetStatus: SqlFixtureCapabilityStatus;
  readonly observedStatus?: SqlFixtureCapabilityStatus;
  readonly observedOutcome: SqlFixtureObservedOutcome;
  readonly expectedInventory: SqlFixtureInventory;
  readonly preservedDbmlFragments?: readonly string[];
  readonly droppedDbmlFragments?: readonly string[];
}

const EXPECTED_OUTPUT_HASHES: Readonly<
  Record<string, { readonly generatedDbml: string; readonly schema: string }>
> = {
  "mysql-alter-add-foreign-key": {
    generatedDbml: "0ced0fac3f1b7f714f62e914eacd7e7be593fe944ee3446b8e8220279e9c77e4",
    schema: "25f8b6685beb9eba47f09ab30827519d3590b31a17b339e668745dac36a1e521",
  },
  "mysql-alter-add-unique": {
    generatedDbml: "ff980e8eb23104ff39f4d0b3e93e41127581a75121149c9470eef18a99197084",
    schema: "abb0fbbe1d1d53accd007b8887de72e6ae59bfef37192ed7f25ac938a2961d87",
  },
  "mysql-alter-column-mutation": {
    generatedDbml: "f206df94d7ef1e97cc6342563191d885bc0f0e4e9d219b76c963e6a35ffdea1d",
    schema: "dd46b452f6eed1b040b4472004fb2cb063248e810192665e746e98ea255f76b4",
  },
  "mysql-auto-increment": {
    generatedDbml: "4bf9fafdc3b8ee5aa79db8279954699742f0c4258dd59b417262b220c685e5dc",
    schema: "6d97eda87a144beabe3d324fccf5696241646edb16a1e10b54cfb7bcc232a658",
  },
  "mysql-basic-constraints": {
    generatedDbml: "68f133b4a6c2a637875b019bddfbf49421629db31abfb9ed01a174615271486e",
    schema: "3c78103e5ca76f62ca6534caa920ba17a34b6e9e4befcce4392a6103e805ad9e",
  },
  "mysql-comments": {
    generatedDbml: "bae1fc9170988d16b1aa1bab8206216dc92aa0155b8808036ca3bb2bba0b2439",
    schema: "89de0ae350a8e2fbf5b4296d89443aa274a7a28455b2b3b57a95af2ac961416c",
  },
  "mysql-composite-keys": {
    generatedDbml: "4292614e62b9b540a6ff8b7a835618210323bd9daaf1d30e2b7bbbe55d329ce1",
    schema: "65f1a637aadb05df8276e47f10b3728a867c0b46892f16ba9fe011356c50ff1d",
  },
  "mysql-create-table": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "mysql-dml": {
    generatedDbml: "7bcda326883c46eb139a984d9853bf1b46a8baad14f33437c109db3d7f353d00",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "mysql-drop-statement": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "mysql-enum": {
    generatedDbml: "79af519ad1a3ad173f477a350062b9c9970ab1082b4c93ddae97c7ac566fed6f",
    schema: "e24e9e7bb4514a298c536d3950887ad238396709dc064eb263667a44bc3f17c3",
  },
  "mysql-foreign-key-actions": {
    generatedDbml: "25a001a7fe5e4b185024b4635840e074193c6312ecd9a0612e25881a30f7283a",
    schema: "e9ebe41b13d4f1b2c6dfaef4ff6cf2da9f68eb0939e1079d42aba6b6552d5cf5",
  },
  "mysql-function-index": {
    generatedDbml: "88508b3e6b87f08feeca29f8499b88913ca2aa52ad27b766fdd57403918a9e2f",
    schema: "6bead0fe0a970bb32f3212352433f36b0f9709a0d98a56fa6cd7c49046c378c8",
  },
  "mysql-generated-column": {
    generatedDbml: "790504257b201ee5f8a9c7d66011816caa2cf70a4ce858fba92be412ff92eb6e",
    schema: "96e0a84f42236e94e3211b88c419d41084f3c5cc6efde94d7f785f36a133ecd2",
  },
  "mysql-indexes": {
    generatedDbml: "c3d7452ae7ac5fa76a9a36a557948d43a7314b2ae6387f29a349109e4cdcd681",
    schema: "5eb800cefb963578c97c45c8affba5f13a7b06aa80669672b150aed22ab1adfa",
  },
  "mysql-procedure": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "mysql-qualified-table": {
    generatedDbml: "c3ec48f5c21fc4315f832e286dd3188408e24bda24b3a4a240b4c8cf37681edd",
    schema: "9d260cab1f9fb5eff862d0129de1f1e3b17ad251a070039a97bda9d6cd6686f7",
  },
  "mysql-table-options": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "mysql-trigger": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "mysql-view": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-alter-add-foreign-key": {
    generatedDbml: "0ced0fac3f1b7f714f62e914eacd7e7be593fe944ee3446b8e8220279e9c77e4",
    schema: "25f8b6685beb9eba47f09ab30827519d3590b31a17b339e668745dac36a1e521",
  },
  "postgresql-alter-add-unique": {
    generatedDbml: "f9713113f5e266b1f71c88c06090cfc589c2eee35eb240436ff6aa266f23392e",
    schema: "34fec5c6105e4fdb0478e0c2b9039a91d8d50da9afbbdd6743d384b7c1e2bbf3",
  },
  "postgresql-alter-column-mutation": {
    generatedDbml: "78db0a102e0367c14369e051ed5351cf119b9c7e08d7af9299fd8f4915d3085d",
    schema: "ccce1e34f6ac7af00178ff8a121463fe6e93a88e99955a899b703f2e8b06cf7a",
  },
  "postgresql-array-builtin": {
    generatedDbml: "4898f22a9777139489d0e3578d8c698ade352d6b56d21755c73404ad763723b9",
    schema: "f528173d42b6c9d1c055d58f48af496aa6dbdc95d4dc38729a04cba837a7a80b",
  },
  "postgresql-array-schema-enum": {
    generatedDbml: "b9ab54170a07cbcbf38b4136bfa4c728a73930baade13880749644528529f3c8",
    schema: "739f22b7d8180b90554b766d070be2154d56dffde3f3d382ab46ebea91915f20",
  },
  "postgresql-basic-constraints": {
    generatedDbml: "c1a25269ac100413c0c8dc063d52d5b47ab23113590c933859aed0dfebc2bbfe",
    schema: "e9b34e21fd36b4b542db2ec5d739face8ffc4e3233e0fd85d582b449c11bfa45",
  },
  "postgresql-comments": {
    generatedDbml: "bae1fc9170988d16b1aa1bab8206216dc92aa0155b8808036ca3bb2bba0b2439",
    schema: "89de0ae350a8e2fbf5b4296d89443aa274a7a28455b2b3b57a95af2ac961416c",
  },
  "postgresql-composite-keys": {
    generatedDbml: "4292614e62b9b540a6ff8b7a835618210323bd9daaf1d30e2b7bbbe55d329ce1",
    schema: "65f1a637aadb05df8276e47f10b3728a867c0b46892f16ba9fe011356c50ff1d",
  },
  "postgresql-copy-data": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-create-table": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-dml": {
    generatedDbml: "7bcda326883c46eb139a984d9853bf1b46a8baad14f33437c109db3d7f353d00",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-drop-statement": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-enum": {
    generatedDbml: "33c1d42c46ad4c2588926638bcbf3f2588039beb94ebf6abe988c8e1b6e0c803",
    schema: "6dcd0c93e71e9a1c21bfa6b19f32c4b5fc332f9a8fb6db96e8ee09708d548f62",
  },
  "postgresql-foreign-key-actions": {
    generatedDbml: "f78ed33390176e4a6a52f6bd220e9e7fd15dbba67646741db3bceb2954817dc3",
    schema: "521d1595c73a8ff792f5950454086b57dcc18f6ec083f6568772682f64b3530b",
  },
  "postgresql-function-index": {
    generatedDbml: "5b9171d11fa0bd17e4b0f7f48c211959e9b843b58d6e5a2309f9ded8e2e6ec1a",
    schema: "08dd3c0e3037174f7d6e62ebfde37238cab96580aa1f2df32254facba68e0df3",
  },
  "postgresql-generated-column": {
    generatedDbml: "790504257b201ee5f8a9c7d66011816caa2cf70a4ce858fba92be412ff92eb6e",
    schema: "96e0a84f42236e94e3211b88c419d41084f3c5cc6efde94d7f785f36a133ecd2",
  },
  "postgresql-identity": {
    generatedDbml: "4bf9fafdc3b8ee5aa79db8279954699742f0c4258dd59b417262b220c685e5dc",
    schema: "6d97eda87a144beabe3d324fccf5696241646edb16a1e10b54cfb7bcc232a658",
  },
  "postgresql-index-methods": {
    generatedDbml: "ed052955803b2252a014be068e7132f3be79804e706917074e9d431f60f39b0d",
    schema: "f1f8d2f3226b6b0fafef282f1fb65f4fdbeba2aed8f85667fa28fb96990b0ed1",
  },
  "postgresql-partial-index": {
    generatedDbml: "fe91764c439440976c0dcaba8ab4dcd671e45adaa271250be96d2f67148d7de9",
    schema: "4ecf61808ad1cd1b62ca4b14d5482605c3e69f429dcd83c2e395b04a8c2db3e5",
  },
  "postgresql-procedure-function": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-qualified-table": {
    generatedDbml: "c3ec48f5c21fc4315f832e286dd3188408e24bda24b3a4a240b4c8cf37681edd",
    schema: "9d260cab1f9fb5eff862d0129de1f1e3b17ad251a070039a97bda9d6cd6686f7",
  },
  "postgresql-serial": {
    generatedDbml: "5d84eadf16dc4e080aa763dabc2d8f055fd73aa37fdd0bdfb13420b5f2be4865",
    schema: "cd06b761aea67e42271bab5a829060d62f3fbc4a0b85ab33c0f7b2cd3fb3c2f1",
  },
  "postgresql-tablespace": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-trigger": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
  "postgresql-view": {
    generatedDbml: "fff97c7c9c83e9b389bf9729a1f4302a937f7762c192aecff0de293482367201",
    schema: "1a9a1d445e005a6ed2f79c53187a67909e858975461b32b4c0858f3c1ea0ae5d",
  },
};

const inputs: readonly FixtureInput[] = [
  fixtureInput("mysql-alter-add-foreign-key", "ALTER_ADD_FOREIGN_KEY", "MYSQL", {
    source: `CREATE TABLE parent (id bigint PRIMARY KEY);
CREATE TABLE child (parent_id bigint);
ALTER TABLE child ADD CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE;
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(2, 0, 1),
    preserved: ['Ref "child_parent_fk"'],
  }),
  fixtureInput("mysql-alter-add-unique", "ALTER_ADD_UNIQUE", "MYSQL", {
    source: `CREATE TABLE samples (id bigint, code varchar(64));
ALTER TABLE samples ADD CONSTRAINT samples_code_unique UNIQUE (code);
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["[unique]"],
  }),
  fixtureInput("mysql-alter-column-mutation", "ALTER_COLUMN_MUTATION", "MYSQL", {
    source: `CREATE TABLE samples (id bigint, legacy varchar(32));
ALTER TABLE samples ADD COLUMN email varchar(255);
ALTER TABLE samples DROP COLUMN legacy;
ALTER TABLE samples RENAME COLUMN id TO sample_id;
ALTER TABLE samples MODIFY COLUMN legacy varchar(64);
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['"id" bigint', '"legacy" varchar(32)'],
    dropped: ['"email"', '"sample_id"', "varchar(64)"],
  }),
  fixtureInput("mysql-auto-increment", "AUTO_INCREMENT", "MYSQL", {
    source: "CREATE TABLE samples (id bigint AUTO_INCREMENT PRIMARY KEY);\n",
    targetStatus: "NORMALIZED",
    observedOutcome: "NORMALIZED",
    inventory: inventory(1, 0, 0),
    preserved: ['"id" bigint [pk, increment]'],
    dropped: ["AUTO_INCREMENT"],
  }),
  fixtureInput("mysql-basic-constraints", "BASIC_CONSTRAINTS", "MYSQL", {
    source:
      "CREATE TABLE samples (id bigint PRIMARY KEY, value int CHECK (value > 0), code varchar(16) UNIQUE NOT NULL DEFAULT 'x');\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ["[pk]", "check: `value > 0`", "[unique, not null, default: 'x']"],
  }),
  fixtureInput("mysql-comments", "COMMENTS", "MYSQL", {
    source:
      "CREATE TABLE samples (id bigint COMMENT 'Synthetic identifier') COMMENT='Synthetic table';\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ["note: 'Synthetic identifier'", "Note: 'Synthetic table'"],
  }),
  fixtureInput("mysql-composite-keys", "COMPOSITE_KEYS", "MYSQL", {
    source: `CREATE TABLE parent (tenant_id bigint, id bigint, PRIMARY KEY (tenant_id, id));
CREATE TABLE child (tenant_id bigint, parent_id bigint, CONSTRAINT child_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES parent(tenant_id, id));
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(2, 0, 1),
    preserved: ["(tenant_id, id) [pk]", 'Ref "child_parent_fk"'],
  }),
  fixtureInput("mysql-create-table", "CREATE_TABLE", "MYSQL", {
    source: "CREATE TABLE samples (id bigint);\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"', '"id" bigint'],
  }),
  fixtureInput("mysql-dml", "DML", "MYSQL", {
    source: `CREATE TABLE samples (id bigint);
INSERT INTO samples VALUES (1);
UPDATE samples SET id = 2;
DELETE FROM samples;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "EMITS_RECORDS",
    inventory: inventory(1, 0, 0),
    preserved: ["Records samples(id)", "  1"],
    dropped: ["UPDATE", "DELETE"],
  }),
  fixtureInput("mysql-drop-statement", "DROP_STATEMENT", "MYSQL", {
    source: `CREATE TABLE samples (id bigint);
DROP TABLE samples;
DROP INDEX missing_index ON samples;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["DROP TABLE", "DROP INDEX"],
  }),
  fixtureInput("mysql-enum", "ENUM", "MYSQL", {
    source: "CREATE TABLE samples (status enum('active', 'disabled') NOT NULL);\n",
    targetStatus: "NORMALIZED",
    observedOutcome: "NORMALIZED",
    inventory: inventory(1, 1, 0),
    preserved: ['Enum "samples_status_enum"', '"status" samples_status_enum [not null]'],
    dropped: ["enum('active', 'disabled')"],
  }),
  fixtureInput("mysql-foreign-key-actions", "FOREIGN_KEY_ACTIONS", "MYSQL", {
    source: `CREATE TABLE parent (id bigint PRIMARY KEY);
CREATE TABLE child (parent_id bigint, CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE ON UPDATE RESTRICT);
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(2, 0, 1),
    preserved: ["[update: restrict, delete: cascade]"],
  }),
  fixtureInput("mysql-function-index", "FUNCTION_INDEX", "MYSQL", {
    source: "CREATE TABLE samples (email varchar(255), INDEX idx_lower_email ((lower(email))));\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['`(lower(email))` [name: "idx_lower_email"]'],
  }),
  fixtureInput("mysql-generated-column", "GENERATED_COLUMN", "MYSQL", {
    source:
      "CREATE TABLE samples (base_value int, computed_value int GENERATED ALWAYS AS (base_value * 2) STORED);\n",
    targetStatus: "PARTIAL",
    observedOutcome: "PARTIALLY_PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['"computed_value" int'],
    dropped: ["base_value * 2", "GENERATED", "STORED"],
  }),
  fixtureInput("mysql-indexes", "MYSQL_INDEXES", "MYSQL", {
    source:
      "CREATE TABLE samples (tenant_id bigint, code varchar(32), INDEX idx_code (code), UNIQUE KEY uq_tenant_code (tenant_id, code));\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['code [name: "idx_code"]', '(tenant_id, code) [unique, name: "uq_tenant_code"]'],
  }),
  fixtureInput("mysql-procedure", "PROCEDURE_OR_FUNCTION_BODY", "MYSQL", {
    source: `CREATE TABLE samples (id bigint);
CREATE PROCEDURE touch_sample() SELECT 1;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["PROCEDURE", "touch_sample"],
  }),
  fixtureInput("mysql-qualified-table", "SCHEMA_QUALIFIED_TABLE", "MYSQL", {
    source: "CREATE TABLE app.samples (id bigint PRIMARY KEY);\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "app"."samples"'],
  }),
  fixtureInput("mysql-table-options", "MYSQL_TABLE_OPTIONS", "MYSQL", {
    source:
      "CREATE TABLE samples (id bigint) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n",
    targetStatus: "PARTIAL",
    observedOutcome: "PARTIALLY_PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["InnoDB", "utf8mb4", "utf8mb4_unicode_ci"],
  }),
  fixtureInput("mysql-trigger", "TRIGGER", "MYSQL", {
    source: `CREATE TABLE samples (id bigint);
CREATE TRIGGER samples_touch BEFORE INSERT ON samples FOR EACH ROW SET NEW.id = 1;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["TRIGGER", "samples_touch"],
  }),
  fixtureInput("mysql-view", "VIEW", "MYSQL", {
    source: `CREATE TABLE samples (id bigint);
CREATE VIEW sample_view AS SELECT id FROM samples;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["sample_view", "CREATE VIEW"],
  }),
  fixtureInput("postgresql-alter-add-foreign-key", "ALTER_ADD_FOREIGN_KEY", "POSTGRESQL", {
    source: `CREATE TABLE parent (id bigint PRIMARY KEY);
CREATE TABLE child (parent_id bigint);
ALTER TABLE child ADD CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE;
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(2, 0, 1),
    preserved: ['Ref "child_parent_fk"'],
  }),
  fixtureInput("postgresql-alter-add-unique", "ALTER_ADD_UNIQUE", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint, code text);
ALTER TABLE samples ADD CONSTRAINT samples_code_unique UNIQUE (code);
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['"code" text [unique]'],
  }),
  fixtureInput("postgresql-alter-column-mutation", "ALTER_COLUMN_MUTATION", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint, legacy text);
ALTER TABLE samples ADD COLUMN email text;
ALTER TABLE samples DROP COLUMN legacy;
ALTER TABLE samples RENAME COLUMN id TO sample_id;
ALTER TABLE samples ALTER COLUMN legacy TYPE varchar(64);
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['"id" bigint', '"legacy" text'],
    dropped: ['"email"', '"sample_id"', "varchar(64)"],
  }),
  fixtureInput("postgresql-array-builtin", "ARRAY_BUILTIN", "POSTGRESQL", {
    source: "CREATE TABLE samples (tags text[], matrix integer[][]);\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['"tags" "text[]"', '"matrix" "integer[][]"'],
  }),
  fixtureInput("postgresql-array-schema-enum", "ARRAY_SCHEMA_ENUM", "POSTGRESQL", {
    source: `CREATE SCHEMA app;
CREATE TYPE app.mood AS ENUM ('happy', 'sad');
CREATE TABLE app.samples (moods app.mood[]);
`,
    targetStatus: "EXACT",
    observedStatus: "PARTIAL",
    observedOutcome: "PARTIALLY_PRESERVED",
    inventory: inventory(1, 1, 0),
    preserved: ['"moods" app."app.mood[]"'],
    dropped: ['"moods" app."mood[]"'],
  }),
  fixtureInput("postgresql-basic-constraints", "BASIC_CONSTRAINTS", "POSTGRESQL", {
    source:
      "CREATE TABLE samples (id bigint PRIMARY KEY, value int CHECK (value > 0), code text UNIQUE NOT NULL DEFAULT 'x');\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ["[pk]", "check: `value > 0`", "[unique, not null, default: 'x']"],
  }),
  fixtureInput("postgresql-comments", "COMMENTS", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint);
COMMENT ON TABLE samples IS 'Synthetic table';
COMMENT ON COLUMN samples.id IS 'Synthetic identifier';
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ["note: 'Synthetic identifier'", "Note: 'Synthetic table'"],
  }),
  fixtureInput("postgresql-composite-keys", "COMPOSITE_KEYS", "POSTGRESQL", {
    source: `CREATE TABLE parent (tenant_id bigint, id bigint, PRIMARY KEY (tenant_id, id));
CREATE TABLE child (tenant_id bigint, parent_id bigint, CONSTRAINT child_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES parent(tenant_id, id));
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(2, 0, 1),
    preserved: ["(tenant_id, id) [pk]", 'Ref "child_parent_fk"'],
  }),
  fixtureInput("postgresql-copy-data", "COPY_DATA", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint);
COPY samples (id) FROM '/synthetic/samples.csv';
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["COPY", "/synthetic/samples.csv"],
  }),
  fixtureInput("postgresql-create-table", "CREATE_TABLE", "POSTGRESQL", {
    source: "CREATE TABLE samples (id bigint);\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"', '"id" bigint'],
  }),
  fixtureInput("postgresql-dml", "DML", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint);
INSERT INTO samples VALUES (1);
UPDATE samples SET id = 2;
DELETE FROM samples;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "EMITS_RECORDS",
    inventory: inventory(1, 0, 0),
    preserved: ["Records samples(id)", "  1"],
    dropped: ["UPDATE", "DELETE"],
  }),
  fixtureInput("postgresql-drop-statement", "DROP_STATEMENT", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint);
DROP TABLE samples;
DROP INDEX missing_index;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["DROP TABLE", "DROP INDEX"],
  }),
  fixtureInput("postgresql-enum", "ENUM", "POSTGRESQL", {
    source: "CREATE TYPE mood AS ENUM ('active', 'disabled');\n",
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(0, 1, 0),
    preserved: ['Enum "mood"', '"active"', '"disabled"'],
  }),
  fixtureInput("postgresql-foreign-key-actions", "FOREIGN_KEY_ACTIONS", "POSTGRESQL", {
    source: `CREATE TABLE parent (id bigint PRIMARY KEY);
CREATE TABLE child (parent_id bigint, CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE ON UPDATE SET NULL);
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(2, 0, 1),
    preserved: ["[update: set null, delete: cascade]"],
  }),
  fixtureInput("postgresql-function-index", "FUNCTION_INDEX", "POSTGRESQL", {
    source: `CREATE TABLE samples (email text);
CREATE INDEX idx_lower_email ON samples (lower(email));
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['`lower(email)` [name: "idx_lower_email"]'],
  }),
  fixtureInput("postgresql-generated-column", "GENERATED_COLUMN", "POSTGRESQL", {
    source:
      "CREATE TABLE samples (base_value int, computed_value int GENERATED ALWAYS AS (base_value * 2) STORED);\n",
    targetStatus: "PARTIAL",
    observedOutcome: "PARTIALLY_PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['"computed_value" int'],
    dropped: ["base_value * 2", "GENERATED", "STORED"],
  }),
  fixtureInput("postgresql-identity", "IDENTITY", "POSTGRESQL", {
    source:
      "CREATE TABLE samples (id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10) PRIMARY KEY);\n",
    targetStatus: "NORMALIZED",
    observedStatus: "PARTIAL",
    observedOutcome: "PARTIALLY_PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['"id" bigint [pk, increment]'],
    dropped: ["ALWAYS", "START WITH 10"],
  }),
  fixtureInput("postgresql-index-methods", "INDEX_METHODS", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint, body text, location point);
CREATE INDEX samples_gin ON samples USING GIN (body);
CREATE INDEX samples_gist ON samples USING GIST (location);
CREATE INDEX samples_brin ON samples USING BRIN (id);
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ["type: gin", "type: gist", "type: brin"],
  }),
  fixtureInput("postgresql-partial-index", "PARTIAL_INDEX", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint, active boolean);
CREATE INDEX samples_active_idx ON samples (id) WHERE active = true;
`,
    targetStatus: "PARTIAL",
    observedOutcome: "PARTIALLY_PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['id [name: "samples_active_idx"]'],
    dropped: ["WHERE", "active = true"],
  }),
  fixtureInput("postgresql-procedure-function", "PROCEDURE_OR_FUNCTION_BODY", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint);
CREATE FUNCTION touch_sample() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["FUNCTION", "touch_sample", "RETURN NEW"],
  }),
  fixtureInput("postgresql-qualified-table", "SCHEMA_QUALIFIED_TABLE", "POSTGRESQL", {
    source: `CREATE SCHEMA app;
CREATE TABLE app.samples (id bigint PRIMARY KEY);
`,
    targetStatus: "EXACT",
    observedOutcome: "PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "app"."samples"'],
  }),
  fixtureInput("postgresql-serial", "SERIAL", "POSTGRESQL", {
    source: "CREATE TABLE samples (id serial PRIMARY KEY, big_id bigserial);\n",
    targetStatus: "NORMALIZED",
    observedOutcome: "NORMALIZED",
    inventory: inventory(1, 0, 0),
    preserved: ['"id" serial [pk, increment]', '"big_id" bigserial [increment]'],
  }),
  fixtureInput("postgresql-tablespace", "TABLESPACE", "POSTGRESQL", {
    source: "CREATE TABLE samples (id bigint) TABLESPACE pg_default;\n",
    targetStatus: "PARTIAL",
    observedOutcome: "PARTIALLY_PRESERVED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["TABLESPACE", "pg_default"],
  }),
  fixtureInput("postgresql-trigger", "TRIGGER", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint);
CREATE FUNCTION touch_sample() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER samples_touch BEFORE INSERT ON samples FOR EACH ROW EXECUTE FUNCTION touch_sample();
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["TRIGGER", "samples_touch"],
  }),
  fixtureInput("postgresql-view", "VIEW", "POSTGRESQL", {
    source: `CREATE TABLE samples (id bigint);
CREATE VIEW sample_view AS SELECT id FROM samples;
`,
    targetStatus: "UNSUPPORTED",
    observedOutcome: "DROPPED",
    inventory: inventory(1, 0, 0),
    preserved: ['Table "samples"'],
    dropped: ["sample_view", "CREATE VIEW"],
  }),
];

export const sqlCapabilityFixtures: readonly SqlCapabilityFixture[] = inputs
  .map(toCapabilityFixture)
  .sort((left, right) => compareCodeUnits(left.id, right.id));

export const sqlParserErrorFixtures: readonly SqlParserErrorFixture[] = [
  parserErrorFixture({
    id: "mysql-with-postgresql-syntax",
    dialect: "MYSQL",
    source: "CREATE TYPE mood AS ENUM ('happy');\n",
    messageIncludes: "no viable alternative at input 'CREATE TYPE'",
    startLine: 1,
    startColumn: 7,
  }),
  parserErrorFixture({
    id: "postgresql-with-mysql-syntax",
    dialect: "POSTGRESQL",
    source: "CREATE TABLE users(id bigint AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\n",
    messageIncludes: "mismatched input 'AUTO_INCREMENT'",
    startLine: 1,
    startColumn: 29,
  }),
];

export const SQL_CAPABILITY_FIXTURE_SET_HASH = sha256(
  JSON.stringify({
    version: SQL_CAPABILITY_FIXTURE_VERSION,
    capabilityFixtures: sqlCapabilityFixtures,
    parserErrorFixtures: sqlParserErrorFixtures,
  }),
);

function fixtureInput(
  id: string,
  capabilityId: SqlFixtureCapabilityId,
  dialect: SqlFixtureDialect,
  input: {
    readonly source: string;
    readonly targetStatus: SqlFixtureCapabilityStatus;
    readonly observedStatus?: SqlFixtureCapabilityStatus;
    readonly observedOutcome: SqlFixtureObservedOutcome;
    readonly inventory: SqlFixtureInventory;
    readonly preserved?: readonly string[];
    readonly dropped?: readonly string[];
  },
): FixtureInput {
  return {
    id,
    capabilityId,
    dialect,
    source: input.source,
    targetStatus: input.targetStatus,
    observedOutcome: input.observedOutcome,
    expectedInventory: input.inventory,
    ...(input.observedStatus === undefined ? {} : { observedStatus: input.observedStatus }),
    ...(input.preserved === undefined ? {} : { preservedDbmlFragments: input.preserved }),
    ...(input.dropped === undefined ? {} : { droppedDbmlFragments: input.dropped }),
  };
}

function toCapabilityFixture(input: FixtureInput): SqlCapabilityFixture {
  const expectedHashes = EXPECTED_OUTPUT_HASHES[input.id];
  if (expectedHashes === undefined) {
    throw new Error(`Missing SQL capability golden hashes for ${input.id}`);
  }
  return {
    id: input.id,
    capabilityId: input.capabilityId,
    dialect: input.dialect,
    source: input.source,
    sourceHash: sha256(input.source),
    targetStatus: input.targetStatus,
    observedStatus: input.observedStatus ?? input.targetStatus,
    observedOutcome: input.observedOutcome,
    expectedGeneratedDbmlHash: expectedHashes.generatedDbml,
    expectedSchemaHash: expectedHashes.schema,
    expectedInventory: input.expectedInventory,
    preservedDbmlFragments: input.preservedDbmlFragments ?? [],
    droppedDbmlFragments: input.droppedDbmlFragments ?? [],
  };
}

function parserErrorFixture(input: {
  readonly id: string;
  readonly dialect: SqlFixtureDialect;
  readonly source: string;
  readonly messageIncludes: string;
  readonly startLine: number;
  readonly startColumn: number;
}): SqlParserErrorFixture {
  return {
    id: input.id,
    dialect: input.dialect,
    source: input.source,
    sourceHash: sha256(input.source),
    expectedError: {
      messageIncludes: input.messageIncludes,
      startLine: input.startLine,
      startColumn: input.startColumn,
    },
  };
}

function inventory(tables: number, enums: number, references: number): SqlFixtureInventory {
  return { tables, enums, references };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

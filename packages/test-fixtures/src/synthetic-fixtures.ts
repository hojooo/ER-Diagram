import { createHash } from "node:crypto";

export const DEFAULT_FIXTURE_SEED = 20260826;

export type FixtureKind = "fidelity" | "scale";

export interface FixtureInventory {
  readonly tables: number;
  readonly enums: number;
  readonly tablePartials: number;
  readonly tableGroups: number;
  readonly diagramViews: number;
  readonly references: number;
}

export const fixtureInventory = {
  fidelity: {
    tables: 143,
    enums: 86,
    tablePartials: 4,
    tableGroups: 15,
    diagramViews: 7,
    references: 573,
  },
  scale: {
    tables: 200,
    enums: 0,
    tablePartials: 0,
    tableGroups: 0,
    diagramViews: 0,
    references: 1_000,
  },
} as const satisfies Readonly<Record<FixtureKind, FixtureInventory>>;

const COLORS = [
  "#3498DB",
  "#2ECC71",
  "#9B59B6",
  "#E67E22",
  "#1ABC9C",
  "#E74C3C",
  "#34495E",
] as const;

interface ScalarReference {
  readonly name: string;
  readonly sourceTable: string;
  readonly sourceField: string;
  readonly targetTable: string;
}

function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError("seed must be a safe integer");
  }
}

function seedLabel(seed: number): string {
  const sign = seed < 0 ? "n" : "p";
  return `s${sign}${Math.abs(seed).toString(36)}`;
}

function pad(value: number, width: number): string {
  return value.toString(10).padStart(width, "0");
}

function selectColor(seed: number, offset: number): (typeof COLORS)[number] {
  const index = ((seed % COLORS.length) + COLORS.length + offset) % COLORS.length;
  return COLORS[index] ?? COLORS[0];
}

function assemble(sections: readonly string[]): string {
  return `${sections.join("\n\n")}\n`;
}

function fidelityTableNames(): string[] {
  return Array.from({ length: fixtureInventory.fidelity.tables }, (_, index) =>
    index === 0 ? 'catalog."Quoted Entity"' : `core.entity_${pad(index, 3)}`,
  );
}

function buildFidelityReferences(tableNames: readonly string[]): {
  readonly sourceFields: ReadonlyMap<string, readonly string[]>;
  readonly declarations: readonly string[];
} {
  const mutableSourceFields = new Map<string, string[]>();
  const declarations: string[] = [];

  const compositeSource = tableNames[2];
  const compositeTarget = tableNames[1];
  if (compositeSource === undefined || compositeTarget === undefined) {
    throw new Error("fidelity fixture requires at least three tables");
  }

  declarations.push(
    `Ref composite_tenant_identity: ${compositeSource}.(parent_tenant_id, parent_id) > ${compositeTarget}.(tenant_id, id) [delete: no action, update: cascade]`,
  );

  for (
    let relationIndex = 1;
    relationIndex < fixtureInventory.fidelity.references;
    relationIndex += 1
  ) {
    const sourceIndex = 1 + ((relationIndex * 37) % (tableNames.length - 1));
    const targetOffset = 1 + (relationIndex % (tableNames.length - 2));
    const targetIndex = 1 + ((sourceIndex - 1 + targetOffset) % (tableNames.length - 1));
    const sourceTable = tableNames[sourceIndex];
    const targetTable = tableNames[targetIndex];

    if (sourceTable === undefined || targetTable === undefined) {
      throw new Error("generated reference points outside the fidelity table inventory");
    }

    const reference: ScalarReference = {
      name: `ref_${pad(relationIndex, 4)}`,
      sourceTable,
      sourceField: `ref_${pad(relationIndex, 4)}_id`,
      targetTable,
    };
    const fields = mutableSourceFields.get(reference.sourceTable) ?? [];
    fields.push(reference.sourceField);
    mutableSourceFields.set(reference.sourceTable, fields);

    declarations.push(
      `Ref ${reference.name}: ${reference.sourceTable}.${reference.sourceField} > ${reference.targetTable}.id [delete: no action, update: no action]`,
    );
  }

  return { sourceFields: mutableSourceFields, declarations };
}

function buildFidelityPartials(label: string): string[] {
  return [
    [
      "TablePartial audit_fields {",
      `  created_at timestamp [not null, default: \`now()\`, provenance: "${label}"]`,
      "  updated_at timestamp [not null, default: `now()`]",
      "  Note: 'Synthetic audit fields shared by generated tables'",
      "}",
    ].join("\n"),
    [
      "TablePartial lifecycle_fields {",
      "  lifecycle_state varchar [not null, default: 'active']",
      "  archived_at timestamp",
      "  Note: 'Synthetic lifecycle fields'",
      "}",
    ].join("\n"),
    [
      "TablePartial ownership_fields {",
      '  owner_key varchar [not null, classification: "synthetic"]',
      "  ownership_updated_at timestamp",
      "  Note: 'Synthetic ownership fields'",
      "}",
    ].join("\n"),
    [
      "TablePartial trace_fields {",
      "  trace_token varchar [not null]",
      "  trace_sequence bigint [not null, default: 0]",
      "  Note: 'Synthetic trace fields'",
      "}",
    ].join("\n"),
  ];
}

function buildFidelityEnums(label: string): string[] {
  return Array.from({ length: fixtureInventory.fidelity.enums }, (_, index) => {
    const name = `synthetic.status_${pad(index, 3)}`;
    return [
      `Enum ${name} {`,
      `  pending [note: 'Synthetic pending value ${label}']`,
      "  active",
      "  archived",
      "}",
    ].join("\n");
  });
}

function buildFidelityTables(
  seed: number,
  label: string,
  tableNames: readonly string[],
  sourceFields: ReadonlyMap<string, readonly string[]>,
): string[] {
  const partialNames = [
    "audit_fields",
    "lifecycle_fields",
    "ownership_fields",
    "trace_fields",
  ] as const;

  return tableNames.map((tableName, index) => {
    const localName = index === 0 ? "quoted_entity" : `entity_${pad(index, 3)}`;
    const lines = [
      `Table ${tableName} [headercolor: ${selectColor(seed, index)}, owner: "synthetic-${label}", fixture_seed: "${label}"] {`,
      `  id bigint [pk, increment, note: 'Synthetic identifier for ${localName}']`,
      "  tenant_id bigint [not null]",
      `  status synthetic.status_${pad(index % fixtureInventory.fidelity.enums, 3)} [not null]`,
    ];

    if (index === 0) {
      lines.push("  \"display label\" varchar [note: 'Quoted synthetic identifier coverage']");
    }
    if (index === 2) {
      lines.push("  parent_tenant_id bigint [not null]", "  parent_id bigint [not null]");
    }

    for (const fieldName of sourceFields.get(tableName) ?? []) {
      lines.push(`  ${fieldName} bigint`);
    }

    const partialName = partialNames[index % partialNames.length] ?? partialNames[0];
    lines.push(
      `  ~${partialName}`,
      `  Note: 'Public synthetic table ${pad(index, 3)} for parser and layout verification'`,
      "",
      "  indexes {",
      `    (tenant_id, id) [unique, name: 'uq_${localName}_tenant_identity']`,
      "  }",
      "}",
    );

    return lines.join("\n");
  });
}

function buildFidelityGroups(seed: number, label: string, tableNames: readonly string[]): string[] {
  const membersByGroup = Array.from(
    { length: fixtureInventory.fidelity.tableGroups },
    () => [] as string[],
  );

  tableNames.forEach((tableName, tableIndex) => {
    const groupIndex = Math.min(
      Math.floor((tableIndex * fixtureInventory.fidelity.tableGroups) / tableNames.length),
      fixtureInventory.fidelity.tableGroups - 1,
    );
    membersByGroup[groupIndex]?.push(tableName);
  });

  return membersByGroup.map((members, groupIndex) =>
    [
      `TableGroup domain_${pad(groupIndex, 2)} [color: ${selectColor(seed, groupIndex)}, team: "synthetic-${label}"] {`,
      ...members.map((member) => `  ${member}`),
      `  Note: 'Synthetic table group ${pad(groupIndex, 2)}'`,
      "}",
    ].join("\n"),
  );
}

function buildFidelityViews(tableNames: readonly string[]): string[] {
  const fullView = [
    "DiagramView full_schema {",
    "  Tables { * }",
    "  Notes { * }",
    "  TableGroups { * }",
    "  Schemas { * }",
    "}",
  ].join("\n");

  const focusedViews = Array.from(
    { length: fixtureInventory.fidelity.diagramViews - 1 },
    (_, viewIndex) => {
      const tableStart = 1 + viewIndex * 20;
      const visibleTables = tableNames.slice(tableStart, tableStart + 12);
      return [
        `DiagramView focus_${pad(viewIndex + 1, 2)} {`,
        "  Tables {",
        ...visibleTables.map((tableName) => `    ${tableName}`),
        "  }",
        `  TableGroups { domain_${pad(viewIndex, 2)} }`,
        "  Schemas { core }",
        "}",
      ].join("\n");
    },
  );

  return [fullView, ...focusedViews];
}

export function generateFidelityFixture(seed = DEFAULT_FIXTURE_SEED): string {
  assertSeed(seed);
  const label = seedLabel(seed);
  const tableNames = fidelityTableNames();
  const references = buildFidelityReferences(tableNames);

  return assemble([
    `// Deterministic public synthetic fixture; seed=${seed}`,
    [
      `Project fidelity_${label} {`,
      "  database_type: 'PostgreSQL'",
      `  Note: 'Public synthetic DBML fidelity fixture ${label}; contains no customer schema data'`,
      "}",
    ].join("\n"),
    ...buildFidelityPartials(label),
    ...buildFidelityEnums(label),
    ...buildFidelityTables(seed, label, tableNames, references.sourceFields),
    [
      `Note synthetic_overview [author: "fixture-${label}", color: ${selectColor(seed, 0)}] {`,
      "  'Generated only from deterministic synthetic labels and relationships'",
      "}",
    ].join("\n"),
    ...buildFidelityGroups(seed, label, tableNames),
    ...references.declarations,
    ...buildFidelityViews(tableNames),
  ]);
}

function scaleTableName(index: number): string {
  return `scale.node_${pad(index, 3)}`;
}

export function generateScaleFixture(seed = DEFAULT_FIXTURE_SEED): string {
  assertSeed(seed);
  const label = seedLabel(seed);
  const fieldsByTable = Array.from({ length: fixtureInventory.scale.tables }, () => [] as string[]);
  const references: ScalarReference[] = [];

  for (
    let relationIndex = 0;
    relationIndex < fixtureInventory.scale.references;
    relationIndex += 1
  ) {
    const sourceIndex = relationIndex % fixtureInventory.scale.tables;
    const edgeOffset = Math.floor(relationIndex / fixtureInventory.scale.tables) + 1;
    const targetIndex = (sourceIndex + edgeOffset) % fixtureInventory.scale.tables;
    const sourceField = `edge_${pad(relationIndex, 4)}_target_id`;
    fieldsByTable[sourceIndex]?.push(sourceField);
    references.push({
      name: `scale_ref_${pad(relationIndex, 4)}`,
      sourceTable: scaleTableName(sourceIndex),
      sourceField,
      targetTable: scaleTableName(targetIndex),
    });
  }

  const tables = fieldsByTable.map((fields, tableIndex) =>
    [
      `Table ${scaleTableName(tableIndex)} [fixture_seed: "${label}"] {`,
      "  id bigint [pk]",
      ...fields.map((field) => `  ${field} bigint`),
      "}",
    ].join("\n"),
  );
  const referenceDeclarations = references.map(
    (reference) =>
      `Ref ${reference.name}: ${reference.sourceTable}.${reference.sourceField} > ${reference.targetTable}.id`,
  );

  return assemble([
    `// Deterministic public scale fixture; seed=${seed}`,
    [
      `Project scale_${label} {`,
      "  database_type: 'PostgreSQL'",
      `  Note: 'Synthetic 200-table and 1000-reference layout fixture ${label}'`,
      "}",
    ].join("\n"),
    ...tables,
    ...referenceDeclarations,
  ]);
}

export function sha256FixtureSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

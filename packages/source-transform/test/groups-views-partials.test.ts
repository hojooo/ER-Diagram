import type { VisualCommand } from "@er-diagram/contracts";
import {
  parseDbmlV2,
  qualifiedElementKey,
  type SchemaElementKey,
  type SchemaGraph,
} from "@er-diagram/core";
import { generateFidelityFixture } from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  type GroupViewVisualCommand,
  transformGroupViewCommand,
  transformRelationshipIndexCheckCommand,
  transformTableColumnCommand,
  transformVisualCommand,
  type VisualPartialImpact,
} from "../src/index.js";
import { resolveVisualPartialImpact } from "../src/partial-impact.js";

const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const USERS_KEY = qualifiedElementKey("table", "public", "users");
const POSTS_KEY = qualifiedElementKey("table", "public", "posts");
const COMMENTS_KEY = qualifiedElementKey("table", "public", "comments");
const GROUP_KEY = qualifiedElementKey("group", "public", "identity domain");
const VIEW_KEY = qualifiedElementKey("view", null, "focus view");
const NOTE_KEY = qualifiedElementKey("note", "docs.note");

const source = `TablePartial audit_fields {
  owner_id bigint [ref: > public.users.id]
  created_at timestamp [check: \`created_at <= now()\`]

  indexes {
    created_at [name: "audit_created_idx"]
  }

  checks {
    \`owner_id > 0\` [name: "positive_owner"]
  }
}

Table public.users {
  id bigint [pk]
}

Table public.posts {
  ~audit_fields
  id bigint [pk]
}

Table public.comments {
  ~audit_fields
  id bigint [pk]
}

Ref local_posts_owner: public.posts.id > public.users.id

Note "docs.note" [color: #778899] {
  "Synthetic docs"
}

// group leading comment
TableGroup "identity domain" [color: #112233, owner: "platform"] {
  // users stay first
  public.users // retained member comment
  public.posts
  Note: "Identity tables"
}

DiagramView "focus view" {
  // view comment must survive
  Tables {
    public.users // visible owner
    public.posts
  }
  Notes { "docs.note" }
  TableGroups { "identity domain" }
  Schemas { public }
}
`;

type CommandInput = GroupViewVisualCommand extends infer Command
  ? Command extends GroupViewVisualCommand
    ? Omit<Command, "commandId" | "expectedSchemaRevisionNo">
    : never
  : never;

function command(value: CommandInput): GroupViewVisualCommand {
  return {
    commandId: COMMAND_ID,
    expectedSchemaRevisionNo: 7,
    ...value,
  } as GroupViewVisualCommand;
}

async function graphOf(dbml: string): Promise<SchemaGraph> {
  const result = await parseDbmlV2(dbml);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.graph;
}

async function expectSuccess(dbml: string, visualCommand: GroupViewVisualCommand) {
  const result = await transformGroupViewCommand(dbml, visualCommand);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(applyTextEdits(dbml, result.edits)).toEqual({ ok: true, source: result.source });
  expect((await parseDbmlV2(result.source)).ok).toBe(true);
  return result;
}

async function expectFailure(dbml: string, visualCommand: GroupViewVisualCommand, code: string) {
  const result = await transformGroupViewCommand(dbml, visualCommand);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected visual command failure");
  expect(result.source).toBe(dbml);
  expect(result.diagnostics[0]).toMatchObject({ code, severity: "ERROR" });
  return result;
}

describe("TableGroup membership source patches", () => {
  it("applies strict add/remove deltas while preserving unrelated group source", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "UPDATE_GROUP_MEMBERSHIP",
        targetGroupKey: GROUP_KEY,
        addTableKeys: [COMMENTS_KEY],
        removeTableKeys: [POSTS_KEY],
      }),
    );

    expect(result.source).toContain("// group leading comment");
    expect(result.source).toContain("// users stay first");
    expect(result.source).toContain("public.users // retained member comment");
    expect(result.source).toContain('Note: "Identity tables"');
    expect(result.source).toContain('owner: "platform"');
    expect(result.source).not.toContain("  public.posts\n  Note:");
    expect(result.source).toContain("  public.comments\n  Note:");
    expect(result.semanticDiff).toEqual({
      changes: [
        {
          operation: "UPDATE",
          elementKind: "group",
          key: GROUP_KEY,
          parentKey: null,
          changedFields: ["tableKeys"],
        },
      ],
      renameCandidates: [],
    });

    const graph = await graphOf(result.source);
    expect(graph.groups.find((group) => group.key === GROUP_KEY)?.tableKeys.toSorted()).toEqual(
      [USERS_KEY, COMMENTS_KEY].toSorted(),
    );
  });

  it("rejects already-member adds and absent-member removals without changing source", async () => {
    await expectFailure(
      source,
      command({
        kind: "UPDATE_GROUP_MEMBERSHIP",
        targetGroupKey: GROUP_KEY,
        addTableKeys: [USERS_KEY],
        removeTableKeys: [],
      }),
      "VISUAL_MEMBERSHIP_CONFLICT",
    );
    await expectFailure(
      source,
      command({
        kind: "UPDATE_GROUP_MEMBERSHIP",
        targetGroupKey: GROUP_KEY,
        addTableKeys: [],
        removeTableKeys: [COMMENTS_KEY],
      }),
      "VISUAL_MEMBERSHIP_CONFLICT",
    );

    const groupedElsewhere = `${source}\nTableGroup secondary {\n  public.comments\n}\n`;
    await expectFailure(
      groupedElsewhere,
      command({
        kind: "UPDATE_GROUP_MEMBERSHIP",
        targetGroupKey: GROUP_KEY,
        addTableKeys: [COMMENTS_KEY],
        removeTableKeys: [],
      }),
      "VISUAL_MEMBERSHIP_CONFLICT",
    );
  });

  it("preserves CRLF and renders qualified quoted identifiers", async () => {
    const dbml = `Table "service.schema"."사용자 😀" {\r\n  id int [pk]\r\n}\r\n\r\nTable public.audit {\r\n  id int [pk]\r\n}\r\n\r\nTableGroup "감사 그룹" {\r\n  public.audit\r\n}\r\n`;
    const result = await expectSuccess(
      dbml,
      command({
        kind: "UPDATE_GROUP_MEMBERSHIP",
        targetGroupKey: qualifiedElementKey("group", "public", "감사 그룹"),
        addTableKeys: [qualifiedElementKey("table", "service.schema", "사용자 😀")],
        removeTableKeys: [],
      }),
    );
    expect(result.source).toContain('  "service.schema"."사용자 😀"\r\n');
    expect(result.source.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("DiagramView source patches", () => {
  it("patches one filter without rewriting comments or unrelated filters", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "UPDATE_DIAGRAM_VIEW",
        targetViewKey: VIEW_KEY,
        changes: { visibleTableKeys: [USERS_KEY, COMMENTS_KEY] },
      }),
    );

    expect(result.source).toContain("// view comment must survive");
    expect(result.source).toContain("public.users // visible owner");
    expect(result.source).toContain('Notes { "docs.note" }');
    expect(result.source).toContain('TableGroups { "identity domain" }');
    expect(result.source).toContain("Schemas { public }");
    expect(result.source).toContain("    public.comments\n");
    expect(result.source).not.toContain("    public.posts\n");
    expect(result.semanticDiff.changes).toEqual([
      {
        operation: "UPDATE",
        elementKind: "view",
        key: VIEW_KEY,
        parentKey: null,
        changedFields: ["visibleTableKeys"],
      },
    ]);
  });

  it("represents one all-filter without changing the other active filters", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "UPDATE_DIAGRAM_VIEW",
        targetViewKey: VIEW_KEY,
        changes: { visibleTableKeys: [] },
      }),
    );
    const graph = await graphOf(result.source);

    expect(graph.views[0]).toMatchObject({
      visibleTableKeys: [],
      visibleNoteKeys: [NOTE_KEY],
      visibleGroupKeys: [GROUP_KEY],
      visibleSchemaNames: ["public"],
    });
    expect(result.source).toContain("// view comment must survive");
    expect(result.source).toContain('Notes { "docs.note" }');
    expect(result.source).toContain('TableGroups { "identity domain" }');
    expect(result.source).toContain("Schemas { public }");
    expect(result.semanticDiff.changes).toEqual([
      {
        operation: "UPDATE",
        elementKind: "view",
        key: VIEW_KEY,
        parentKey: null,
        changedFields: ["visibleTableKeys"],
      },
    ]);
  });

  it("preserves [] | non-empty | null tri-state for every filter kind", async () => {
    const all = await expectSuccess(
      source,
      command({
        kind: "UPDATE_DIAGRAM_VIEW",
        targetViewKey: VIEW_KEY,
        changes: {
          visibleTableKeys: [],
          visibleNoteKeys: [],
          visibleGroupKeys: [],
          visibleSchemaNames: [],
        },
      }),
    );
    const allGraph = await graphOf(all.source);
    expect(allGraph.views[0]).toMatchObject({
      visibleTableKeys: [],
      visibleNoteKeys: [],
      visibleGroupKeys: [],
      visibleSchemaNames: [],
    });

    const hidden = await expectSuccess(
      all.source,
      command({
        kind: "UPDATE_DIAGRAM_VIEW",
        targetViewKey: VIEW_KEY,
        changes: {
          visibleTableKeys: null,
          visibleNoteKeys: null,
          visibleGroupKeys: null,
          visibleSchemaNames: null,
        },
      }),
    );
    const hiddenGraph = await graphOf(hidden.source);
    expect(hiddenGraph.views[0]).toMatchObject({
      visibleTableKeys: null,
      visibleNoteKeys: null,
      visibleGroupKeys: null,
      visibleSchemaNames: null,
    });
    expect(hidden.source).toContain("// view comment must survive");
  });

  it("inserts missing blocks canonically and treats set-equivalent order as a no-op", async () => {
    const minimal = `${source.slice(0, source.indexOf('DiagramView "focus view"'))}DiagramView "focus view" {\n  // empty view\n}\n`;
    const inserted = await expectSuccess(
      minimal,
      command({
        kind: "UPDATE_DIAGRAM_VIEW",
        targetViewKey: VIEW_KEY,
        changes: {
          visibleTableKeys: [COMMENTS_KEY, USERS_KEY],
          visibleNoteKeys: [NOTE_KEY],
          visibleGroupKeys: [GROUP_KEY],
          visibleSchemaNames: ["public"],
        },
      }),
    );
    expect(inserted.source.indexOf("  Tables {")).toBeLessThan(
      inserted.source.indexOf("  Notes {"),
    );
    expect(inserted.source.indexOf("  Notes {")).toBeLessThan(
      inserted.source.indexOf("  TableGroups {"),
    );
    expect(inserted.source.indexOf("  TableGroups {")).toBeLessThan(
      inserted.source.indexOf("  Schemas {"),
    );

    const noOp = await expectSuccess(
      inserted.source,
      command({
        kind: "UPDATE_DIAGRAM_VIEW",
        targetViewKey: VIEW_KEY,
        changes: { visibleTableKeys: [USERS_KEY, COMMENTS_KEY] },
      }),
    );
    expect(noOp).toMatchObject({ changed: false, edits: [], source: inserted.source });
  });
});

describe("TablePartial impact and unified routing", () => {
  async function partialImpactFor(
    visualCommand: VisualCommand,
    transform: (source: string, command: never) => Promise<unknown>,
  ): Promise<VisualPartialImpact> {
    const result = (await transform(source, visualCommand as never)) as Awaited<
      ReturnType<typeof transformVisualCommand>
    >;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected partial target protection");
    expect(result.diagnostics[0]).toMatchObject({ code: "VISUAL_PARTIAL_TARGET_PROTECTED" });
    expect(result.partialImpact).toBeDefined();
    if (!result.partialImpact) throw new Error("expected partial impact");
    return result.partialImpact;
  }

  it("returns definition and every injection range for injected column/index/check/reference", async () => {
    const graph = await graphOf(source);
    const posts = graph.tables.find((table) => table.key === POSTS_KEY);
    const injectedColumn = posts?.columns.find((column) => column.name === "created_at");
    const injectedIndex = posts?.indexes.find((index) => index.name === "audit_created_idx");
    const injectedCheck = posts?.checks.find((check) => check.name === "positive_owner");
    const injectedReference = graph.references.find(
      (reference) =>
        reference.injectedFrom && reference.endpoints.some((e) => e.tableKey === POSTS_KEY),
    );
    if (!injectedColumn || !injectedIndex || !injectedCheck || !injectedReference) {
      throw new Error("expected injected fixture elements");
    }

    const commands: Array<
      [VisualCommand, (dbml: string, command: never) => Promise<unknown>, SchemaElementKey]
    > = [
      [
        {
          commandId: COMMAND_ID,
          expectedSchemaRevisionNo: 7,
          kind: "DELETE_COLUMN",
          targetTableKey: POSTS_KEY,
          targetColumnKey: injectedColumn.key,
        },
        transformTableColumnCommand,
        injectedColumn.injectedFrom?.partialElementKey ?? "",
      ],
      [
        {
          commandId: COMMAND_ID,
          expectedSchemaRevisionNo: 7,
          kind: "DELETE_INDEX",
          targetTableKey: POSTS_KEY,
          targetIndexKey: injectedIndex.key,
        },
        transformRelationshipIndexCheckCommand,
        injectedIndex.injectedFrom?.partialElementKey ?? "",
      ],
      [
        {
          commandId: COMMAND_ID,
          expectedSchemaRevisionNo: 7,
          kind: "DELETE_CHECK",
          targetTableKey: POSTS_KEY,
          ownerColumnKey: null,
          targetCheckKey: injectedCheck.key,
        },
        transformRelationshipIndexCheckCommand,
        injectedCheck.injectedFrom?.partialElementKey ?? "",
      ],
      [
        {
          commandId: COMMAND_ID,
          expectedSchemaRevisionNo: 7,
          kind: "DELETE_REFERENCE",
          targetReferenceKey: injectedReference.key,
        },
        transformRelationshipIndexCheckCommand,
        injectedReference.injectedFrom?.partialElementKey ?? "",
      ],
    ];

    for (const [visualCommand, transformer, partialElementKey] of commands) {
      const impact = await partialImpactFor(visualCommand, transformer);
      expect(impact).toMatchObject({
        partialKey: qualifiedElementKey("partial", "audit_fields"),
        partialName: "audit_fields",
        partialElementKey,
      });
      expect(
        source.slice(impact.definitionRange.startOffset, impact.definitionRange.endOffset),
      ).not.toBe("");
      expect(impact.affectedTables.map((table) => table.tableKey)).toEqual(
        [COMMENTS_KEY, POSTS_KEY].toSorted(),
      );
      for (const table of impact.affectedTables) {
        expect(source.slice(table.injectionRange.startOffset, table.injectionRange.endOffset)).toBe(
          "~audit_fields",
        );
      }
      expect(JSON.parse(JSON.stringify(impact))).toEqual(impact);
      expect(structuredClone(impact)).toEqual(impact);
    }
  });

  it("fails closed instead of returning an incomplete partial impact", async () => {
    const graph = await graphOf(source);
    const injectedColumn = graph.tables
      .find((table) => table.key === POSTS_KEY)
      ?.columns.find((column) => column.name === "created_at");
    if (!injectedColumn?.injectedFrom) throw new Error("expected injected column fixture");

    const inconsistent = structuredClone(graph);
    delete inconsistent.sourceMap[injectedColumn.injectedFrom.partialElementKey];
    expect(resolveVisualPartialImpact(inconsistent, injectedColumn.injectedFrom)).toEqual({
      ok: false,
      message: "The TablePartial definition range is missing or invalid.",
    });
  });

  it("routes all command areas through transformVisualCommand", async () => {
    const groupResult = await transformVisualCommand(
      source,
      command({
        kind: "UPDATE_GROUP_MEMBERSHIP",
        targetGroupKey: GROUP_KEY,
        addTableKeys: [COMMENTS_KEY],
        removeTableKeys: [],
      }),
    );
    expect(groupResult.ok).toBe(true);

    const tableResult = await transformVisualCommand(source, {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 7,
      kind: "UPDATE_TABLE",
      targetTableKey: USERS_KEY,
      changes: { note: "Users" },
    });
    expect(tableResult.ok).toBe(true);

    const graph = await graphOf(source);
    const reference = graph.references.find((item) => item.injectedFrom === null);
    if (!reference) throw new Error("expected local reference fixture");
    const relationshipResult = await transformVisualCommand(source, {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 7,
      kind: "DELETE_REFERENCE",
      targetReferenceKey: reference.key,
    });
    expect(relationshipResult.ok).toBe(true);
  });

  it("retains the synthetic fidelity inventory after a group/view patch", async () => {
    const fixture = generateFidelityFixture();
    const before = await graphOf(fixture);
    const group = before.groups[0];
    const target = group?.tableKeys[0];
    const view = before.views.find((candidate) => candidate.visibleTableKeys?.length);
    if (!group || !target || !view) throw new Error("expected fidelity group/view fixtures");

    const grouped = await transformVisualCommand(fixture, {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 7,
      kind: "UPDATE_GROUP_MEMBERSHIP",
      targetGroupKey: group.key,
      addTableKeys: [],
      removeTableKeys: [target],
    });
    expect(grouped.ok, JSON.stringify(grouped)).toBe(true);
    if (!grouped.ok) return;
    const viewed = await transformVisualCommand(grouped.source, {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 7,
      kind: "UPDATE_DIAGRAM_VIEW",
      targetViewKey: view.key,
      changes: { visibleTableKeys: view.visibleTableKeys?.slice(1) ?? null },
    });
    expect(viewed.ok, JSON.stringify(viewed)).toBe(true);
    if (!viewed.ok) return;
    const after = await graphOf(viewed.source);
    expect({
      tables: after.tables.length,
      enums: after.enums.length,
      partials: after.partials.length,
      groups: after.groups.length,
      views: after.views.length,
      references: after.references.length,
    }).toEqual({ tables: 143, enums: 86, partials: 4, groups: 15, views: 7, references: 573 });
  }, 30_000);
});

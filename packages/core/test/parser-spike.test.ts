import { describe, expect, it } from "vitest";
import {
  fixtureInventory,
  generateFidelityFixture,
  generateScaleFixture,
} from "@er-diagram/test-fixtures";
import {
  DBML_PARSE_MODE,
  parseDbmlProjectV2,
  parseDbmlV2,
  runSameDialectSqlSmoke,
  sha256Utf8,
} from "../src/index.js";
import { parseDbmlV2ForAdapter } from "../src/dbml-parser-adapter.js";

const fidelitySource = `// keep this exact comment: TableGroup should not be stripped
Project synthetic_catalog {
  database_type: 'PostgreSQL'
  Note: 'Public synthetic parser fixture'
}

TablePartial timestamps {
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Enum catalog.status {
  active
  archived
}

Table catalog.users [owner: "identity-team"] {
  ~timestamps
  id bigint [pk]
  status catalog.status [not null]
  "display name" varchar [note: 'quoted identifier']
}

Table catalog.posts {
  id bigint [pk]
  author_id bigint [not null]
  slug varchar [not null]

  indexes {
    (author_id, slug) [unique]
  }
}

Ref author_posts: catalog.posts.author_id > catalog.users.id [delete: cascade]

TableGroup identity [color: #3498DB, owner: "platform"] {
  catalog.users
  catalog.posts
}

DiagramView identity_overview {
  Tables {
    catalog.users
    catalog.posts
  }
  TableGroups {
    identity
  }
}`;

describe("DBML v2 parser spike", () => {
  it("passes the original bytes to the DBML v2 parser and creates a neutral graph", async () => {
    const result = await parseDbmlV2(fidelitySource);

    expect(DBML_PARSE_MODE).toBe("dbmlv2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedHash = await sha256Utf8(fidelitySource);
    expect(result.sourceHash).toBe(expectedHash);
    expect(result.parserInputHash).toBe(expectedHash);
    expect(result.graph.parserVersion).toBe("9.1.1");
    expect(result.graph.tables).toHaveLength(2);
    expect(result.graph.enums).toHaveLength(1);
    expect(result.graph.references).toHaveLength(1);
    expect(result.graph.groups).toHaveLength(1);
    expect(result.graph.partials).toHaveLength(1);
    expect(result.graph.views).toHaveLength(1);
    expect(result.graph.tables[0]?.key).toMatch(/^table:/);
    expect(result.graph.tables[0]?.range.startLine).toBeGreaterThan(0);
    expect(result.graph.tables[0]?.range.endOffset).toBeGreaterThan(
      result.graph.tables[0]?.range.startOffset ?? 0,
    );
    expect(result.graph.sourceMap[result.graph.tables[0]?.key ?? "missing"]).toEqual(
      result.graph.tables[0]?.range,
    );
  });

  it("uses the multifile-aware compiler without rewriting any source", async () => {
    const shared = `Table shared_users {
  id int [pk]
}`;
    const entrypoint = `use * from './shared'

DiagramView shared_overview {
  Tables {
    shared_users
  }
}`;

    const result = await parseDbmlProjectV2({
      entrypoint: "/main.dbml",
      files: {
        "/main.dbml": entrypoint,
        "/shared.dbml": shared,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sourceHashes["/main.dbml"]).toBe(await sha256Utf8(entrypoint));
    expect(result.sourceHashes["/shared.dbml"]).toBe(await sha256Utf8(shared));
    expect(result.parserInputHashes).toEqual(result.sourceHashes);
    expect(result.graph.tables.map((table) => table.key)).toContain(
      'table:["public","shared_users"]',
    );
    expect(result.graph.views.map((view) => view.name)).toEqual(["shared_overview"]);
  });

  it("produces the same neutral semantics through static and project compiler paths", async () => {
    const direct = await parseDbmlV2(fidelitySource);
    const project = await parseDbmlProjectV2({
      entrypoint: "/main.dbml",
      files: { "/main.dbml": fidelitySource },
    });

    expect(direct.ok && project.ok).toBe(true);
    if (!direct.ok || !project.ok) return;

    expect(project.graph.schemaHash).toBe(direct.graph.schemaHash);
    expect({
      tables: project.graph.tables.length,
      enums: project.graph.enums.length,
      references: project.graph.references.length,
      groups: project.graph.groups.length,
      partials: project.graph.partials.length,
      views: project.graph.views.length,
    }).toEqual({
      tables: direct.graph.tables.length,
      enums: direct.graph.enums.length,
      references: direct.graph.references.length,
      groups: direct.graph.groups.length,
      partials: direct.graph.partials.length,
      views: direct.graph.views.length,
    });
  });

  it("returns stable diagnostics for invalid source", async () => {
    const source = "Table broken { id }";
    const result = await parseDbmlV2(source);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.sourceHash).toBe(await sha256Utf8(source));
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "ERROR",
    });
    expect(result.diagnostics[0]?.code).toMatch(/^DBML_/);
    expect(result.diagnostics[0]?.range?.startLine).toBeGreaterThan(0);
  });

  it.each([
    ["fidelity", generateFidelityFixture(), fixtureInventory.fidelity],
    ["scale", generateScaleFixture(), fixtureInventory.scale],
  ])("parses the deterministic %s fixture inventory", async (_name, source, inventory) => {
    const result = await parseDbmlV2(source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect({
      tables: result.graph.tables.length,
      enums: result.graph.enums.length,
      tablePartials: result.graph.partials.length,
      tableGroups: result.graph.groups.length,
      diagramViews: result.graph.views.length,
      references: result.graph.references.length,
    }).toEqual(inventory);
  });

  it.each([
    ["fidelity", generateFidelityFixture()],
    [
      "injected reference",
      `Table users {
  id int [pk]
}

TablePartial ownership {
  user_id int [ref: > users.id]
}

Table posts {
  id int [pk]
  ~ownership
}`,
    ],
    [
      "schema-qualified enum array",
      `Enum "app"."mood" {
  "happy"
  "sad"
}

Table "app"."samples" {
  "moods" app."app.mood[]"
}`,
    ],
  ])("keeps the model-free %s graph identical to the internal adapter", async (_name, source) => {
    const [modelFree, adapter] = await Promise.all([
      parseDbmlV2(source),
      parseDbmlV2ForAdapter(source),
    ]);

    expect(modelFree.ok && adapter.ok).toBe(true);
    if (!modelFree.ok || !adapter.ok) return;
    expect(modelFree.graph).toEqual(adapter.graph);
  });

  it.each([
    [
      "POSTGRESQL" as const,
      `CREATE TABLE users (id BIGINT PRIMARY KEY);
CREATE TABLE posts (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id)
);`,
    ],
    [
      "MYSQL" as const,
      `CREATE TABLE users (id BIGINT PRIMARY KEY);
CREATE TABLE posts (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  CONSTRAINT posts_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
);`,
    ],
  ])("smoke tests same-dialect %s DDL import and export", async (dialect, sql) => {
    const report = await runSameDialectSqlSmoke(sql, dialect);

    expect(report.dialect).toBe(dialect);
    expect(report.importedDbml).toContain("Table");
    expect(report.exportedSql.toUpperCase()).toContain("CREATE TABLE");
    expect(report.before).toEqual(report.after);
    expect(report.before.tables).toBe(2);
    expect(report.before.references).toBe(1);
  });
});

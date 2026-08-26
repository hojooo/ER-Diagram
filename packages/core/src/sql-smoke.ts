import { Parser, exporter, importer, type Database } from "@dbml/core";
import type { PrimaryDialect } from "@er-diagram/contracts";

export interface SqlSmokeInventory {
  tables: number;
  references: number;
}

export interface SameDialectSqlSmokeReport {
  dialect: PrimaryDialect;
  importedDbml: string;
  exportedSql: string;
  before: SqlSmokeInventory;
  dbml: SqlSmokeInventory;
  after: SqlSmokeInventory;
}

export async function runSameDialectSqlSmoke(
  sql: string,
  dialect: PrimaryDialect,
): Promise<SameDialectSqlSmokeReport> {
  const format = dialect === "POSTGRESQL" ? "postgres" : "mysql";
  const sourceDatabase = Parser.parse(sql, format);
  const importedDbml = importer.import(sql, format);
  const dbmlDatabase = Parser.parse(importedDbml, "dbmlv2");
  const exportedSql = exporter.export(importedDbml, format);
  const exportedDatabase = Parser.parse(exportedSql, format);

  const before = inventory(sourceDatabase);
  const dbml = inventory(dbmlDatabase);
  const after = inventory(exportedDatabase);

  if (before.tables !== dbml.tables || before.references !== dbml.references) {
    throw new Error("SQL import smoke changed the table or reference inventory.");
  }
  if (before.tables !== after.tables || before.references !== after.references) {
    throw new Error("Same-dialect SQL export smoke changed the table or reference inventory.");
  }

  return { dialect, importedDbml, exportedSql, before, dbml, after };
}

function inventory(database: Database): SqlSmokeInventory {
  return {
    tables: database.schemas.reduce((count, schema) => count + schema.tables.length, 0),
    references: database.schemas.reduce((count, schema) => count + schema.refs.length, 0),
  };
}

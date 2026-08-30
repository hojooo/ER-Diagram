import { describe, expect, it } from "vitest";

import { getSqlBuiltinTypes } from "../src/index.js";

describe("SQL built-in type catalog", () => {
  it("returns deterministic, duplicate-free dialect catalogs", () => {
    const postgresql = getSqlBuiltinTypes("POSTGRESQL");
    const mysql = getSqlBuiltinTypes("MYSQL");

    expect(postgresql).toEqual([...postgresql].toSorted(compareCodeUnits));
    expect(mysql).toEqual([...mysql].toSorted(compareCodeUnits));
    expect(new Set(postgresql).size).toBe(postgresql.length);
    expect(new Set(mysql).size).toBe(mysql.length);
    expect(postgresql).toContain("uuid");
    expect(postgresql).toContain("jsonb");
    expect(mysql).toContain("tinyint");
    expect(mysql).toContain("longtext");
    expect(mysql).not.toContain("jsonb");
  });

  it("does not expose mutable catalog storage", () => {
    const first = getSqlBuiltinTypes("POSTGRESQL");
    const second = getSqlBuiltinTypes("POSTGRESQL");

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

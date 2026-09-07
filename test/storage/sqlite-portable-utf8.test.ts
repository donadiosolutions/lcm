import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { decodeSqliteUtf8Row, sqliteUtf8Projection } from "../../src/storage/sqlite/portable-utf8.js";

describe("bounded SQLite UTF-8 driver boundary", () => {
  it("preserves quoted identifiers, Unicode including BOM, and native non-text storage classes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const columns = ['quoted"name', "empty", "integer", "real", "blob", "absent"];
      const statement = db.prepare(`SELECT ${sqliteUtf8Projection(columns)} FROM
        (SELECT ? AS "quoted""name", '' AS empty, 9007199254740993 AS integer,
        1.25 AS real, X'80' AS blob, NULL AS absent)`);
      statement.setReadBigInts(true);
      const raw = statement.get("\uFEFF�é水😀")!;
      expect(raw['quoted"name']).toBeInstanceOf(Uint8Array);
      const result = decodeSqliteUtf8Row(raw, columns);
      expect(result).toEqual({ 'quoted"name': "\uFEFF�é水😀", empty: "", integer: 9007199254740993n,
        real: 1.25, blob: new Uint8Array([128]), absent: null });
      expect(raw['quoted"name']).toBeInstanceOf(Uint8Array);
    } finally { db.close(); }
  });

  it.each(["80", "c080", "eda080", "f4908080", "e282", "610062"])("refuses invalid UTF-8 or actual NUL bytes %s without driver substitution", hex => {
    const db = new DatabaseSync(":memory:");
    try {
      const row = db.prepare(`SELECT ${sqliteUtf8Projection(["value"])} FROM (SELECT CAST(X'${hex}' AS TEXT) AS value)`).get()!;
      expect(() => decodeSqliteUtf8Row(row, ["value"])).toThrowError(expect.objectContaining({ code: "unsupported-capability" }));
    } finally { db.close(); }
  });

  it("refuses a tagged text value whose caller already lost the raw bytes", () => {
    expect(() => decodeSqliteUtf8Row({ value: "�", _portable_utf8_type_value: "text" }, ["value"]))
      .toThrowError(expect.objectContaining({ code: "unsupported-capability" }));
  });
});

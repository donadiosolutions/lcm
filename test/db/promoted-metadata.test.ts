import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  normalizePromotedMetadata,
  parsePromotedMetadata,
  PromotedStore,
  serializePromotedMetadata,
} from "../../src/db/promoted.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDb() {
  const directory = mkdtempSync(join(tmpdir(), "lcm-promoted-metadata-"));
  tempDirs.push(directory);
  const db = getLcmConnection(join(directory, "test.db"));
  runLcmMigrations(db);
  return db;
}

describe("promoted memory metadata", () => {
  it("canonicalizes, snapshots, freezes, persists, and updates object metadata", () => {
    const input = {
      z: [true, null, "value", 1.25],
      a: { nested: "yes" },
    };
    const normalized = normalizePromotedMetadata(input);
    input.a.nested = "mutated";
    expect(normalized).toEqual({
      a: { nested: "yes" },
      z: [true, null, "value", 1.25],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.a)).toBe(true);
    expect(serializePromotedMetadata(input))
      .toBe('{"a":{"nested":"mutated"},"z":[true,null,"value",1.25]}');
    expect(parsePromotedMetadata('{"z":1,"a":2}')).toEqual({ a: 2, z: 1 });

    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({
      content: "metadata",
      projectId: "project",
      metadata: { source: "insert" },
    });
    expect(parsePromotedMetadata(store.getById(id)!.metadata))
      .toEqual({ source: "insert" });
    store.update(id, { metadata: { source: "update" } });
    expect(parsePromotedMetadata(store.getById(id)!.metadata))
      .toEqual({ source: "update" });
    store.update(id, {
      content: "metadata updated",
      metadata: { source: "content-update" },
    });
    expect(parsePromotedMetadata(store.getById(id)!.metadata))
      .toEqual({ source: "content-update" });

    const storeWithoutFts = new PromotedStore(db, false);
    const noFtsId = storeWithoutFts.insert({
      content: "metadata without FTS",
      projectId: "project",
    });
    storeWithoutFts.update(noFtsId, {
      tags: ["updated"],
      metadata: { source: "tag-update-without-fts" },
    });
    expect(storeWithoutFts.getById(noFtsId)).toMatchObject({
      tags: '["updated"]',
      metadata: '{"source":"tag-update-without-fts"}',
    });
  });

  it.each([
    { fts5Available: true, label: "FTS" },
    { fts5Available: false, label: "fallback" },
  ])("rolls back tags, metadata, and $label search state after a late metadata failure", ({
    fts5Available,
  }) => {
    const db = makeDb();
    const store = new PromotedStore(db, fts5Available);
    const id = store.insert({
      content: "atomic rollback target",
      tags: ["original"],
      projectId: "project",
      metadata: { source: "original" },
    });
    db.exec(`CREATE TRIGGER reject_promoted_metadata
      BEFORE UPDATE OF metadata ON promoted
      WHEN NEW.metadata <> OLD.metadata
      BEGIN SELECT RAISE(ABORT, 'metadata rejected'); END`);

    store.transaction(() => {
      expect(() => store.update(id, {
        tags: ["partial"],
        metadata: { source: "rejected" },
      })).toThrow("metadata rejected");
      db.prepare("UPDATE promoted SET confidence = ? WHERE id = ?").run(0.75, id);
    });

    expect(store.getById(id)).toMatchObject({
      confidence: 0.75,
      tags: '["original"]',
      metadata: '{"source":"original"}',
    });
    expect(store.search("atomic rollback", 10, ["original"])).toMatchObject([{ id }]);
    expect(store.search("atomic rollback", 10, ["partial"])).toEqual([]);
  });

  it("rejects non-object, non-finite, cyclic, exotic, accessor, and unsafe text", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
    exotic.value = true;
    const symbol = { value: true, [Symbol("hidden")]: true };
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => true,
    });
    let tooDeep: Record<string, unknown> = {};
    const root = tooDeep;
    for (let depth = 0; depth < 101; depth += 1) {
      const next: Record<string, unknown> = {};
      tooDeep.next = next;
      tooDeep = next;
    }
    const invalid: unknown[] = [
      null,
      [],
      "text",
      Number.NaN,
      { value: Number.POSITIVE_INFINITY },
      { value: -0 },
      { value: Number.MAX_SAFE_INTEGER + 1 },
      { value: undefined },
      cyclic,
      exotic,
      symbol,
      accessor,
      { value: "nul\0text" },
      { value: "high\ud800" },
      { value: "low\udfff" },
      { "bad\ud800": true },
      root,
    ];
    for (const value of invalid) {
      expect(() => normalizePromotedMetadata(value)).toThrow(TypeError);
    }
    expect(() => parsePromotedMetadata("{not-json")).toThrow(
      "stored promoted metadata is malformed",
    );
    expect(() => parsePromotedMetadata("[]")).toThrow(
      "metadata must be a JSON object",
    );
  });

  it("rejects array accessors without invoking their getters", () => {
    for (const property of ["0", "extra", "hidden"]) {
      let getterCalls = 0;
      const values: unknown[] = [];
      Object.defineProperty(values, property, {
        enumerable: property !== "hidden",
        get: () => {
          getterCalls += 1;
          return "unsafe";
        },
      });

      let error: unknown;
      try {
        normalizePromotedMetadata({ values });
      } catch (caught) {
        error = caught;
      }
      expect(getterCalls).toBe(0);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "metadata must not contain accessors",
      );
    }
  });

  it("rejects symbol-bearing arrays without invoking symbol getters", () => {
    let getterCalls = 0;
    const values = ["safe"];
    Object.defineProperty(values, Symbol("hidden"), {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });

    let error: unknown;
    try {
      normalizePromotedMetadata({ values });
    } catch (caught) {
      error = caught;
    }
    expect(getterCalls).toBe(0);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "metadata must not contain symbol keys",
    );
  });

  it("preserves empty, nested, sparse, and non-enumerable array values", () => {
    const sparse: unknown[] = new Array(3);
    Object.defineProperty(sparse, "1", {
      enumerable: false,
      value: { nested: ["value"] },
    });
    Object.defineProperty(sparse, "ignored", {
      enumerable: true,
      value: "not an array element",
    });

    const normalized = normalizePromotedMetadata({
      empty: [],
      values: [false, 0, "", null, sparse],
    });
    expect(normalized).toEqual({
      empty: [],
      values: [false, 0, "", null, [
        ,
        { nested: ["value"] },
        ,
      ]],
    });
    const values = normalized["values"];
    expect(Array.isArray(values)).toBe(true);
    const normalizedSparse = (values as unknown[])[4] as unknown[];
    expect(0 in normalizedSparse).toBe(false);
    expect(1 in normalizedSparse).toBe(true);
    expect(2 in normalizedSparse).toBe(false);
    expect(Object.isFrozen(normalizedSparse)).toBe(true);
  });

  it("accepts null-prototype objects, surrogate pairs, and ignores non-enumerable values", () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "hidden", {
      enumerable: false,
      value: undefined,
    });
    value["emoji😀"] = "😀";
    expect(normalizePromotedMetadata(value)).toEqual({ "emoji😀": "😀" });
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";

const RULES_FILE_SHA256 = "ecf4c41c0883dee17d02431e0a7f24a2611aadf8fe1da06e98c6ccb4acc4a981";
const RULES_JSON_SHA256 = "21d9c6e1f20f37d7d804b81dc7f62372b68de9ff05037d5f4f3c85cef4868588";

function schemaBaselineSql(): string {
  return loadPostgreSqlMigrations().find(({ id }) => id === "0002_schema_baseline")?.sql ?? "";
}

function pinnedRules(sql: string): Record<string, string> {
  const match = /\$rules\$(\{[^\n]+\})\$rules\$::jsonb/u.exec(sql);
  expect(match?.[1]).toBeDefined();
  return JSON.parse(match?.[1] ?? "{}") as Record<string, string>;
}

describe("PostgreSQL search normalization artifact", () => {
  it("embeds the complete fingerprinted PostgreSQL 18.4 rule set", () => {
    const sql = schemaBaselineSql();
    const match = /\$rules\$(\{[^\n]+\})\$rules\$::jsonb/u.exec(sql);
    const canonicalRules = match?.[1] ?? "";
    const rules = pinnedRules(sql);

    expect(Object.keys(rules)).toHaveLength(2_661);
    expect(createHash("sha256").update(canonicalRules).digest("hex")).toBe(RULES_JSON_SHA256);
    expect(sql).toContain(`unaccent.rules SHA-256 ${RULES_FILE_SHA256}`);
    expect(rules).toMatchObject({
      "À": "A",
      "ß": "ss",
      "́": "",
      "⅒": " 1/10",
      "∖": "\\",
      "＂": "\"",
      "🄩": "(Z)",
    });
  });

  it("pins immutable normalization to PostgreSQL's builtin Unicode collation", () => {
    const sql = schemaBaselineSql();
    const functionStart = sql.indexOf("CREATE FUNCTION lcm.normalize_search_text(input text)");
    const functionEnd = sql.indexOf("CREATE TABLE lcm.machines", functionStart);
    const definition = sql.slice(functionStart, functionEnd);

    expect(definition).toContain("IMMUTABLE");
    expect(definition).toContain("SET search_path = pg_catalog");
    expect(definition).toContain("COLLATE pg_catalog.pg_unicode_fast");
    expect(definition).not.toContain("pg_catalog.lower(COALESCE(input, ''))");
    expect(definition).not.toContain("public.unaccent(");
    expect(definition).not.toContain("'public.unaccent'::regdictionary");
    expect(sql).toContain(
      "pg_catalog.lower(tag COLLATE pg_catalog.pg_unicode_fast)",
    );
    expect(sql).not.toContain("GENERATED ALWAYS AS (lower(tag))");
  });
});

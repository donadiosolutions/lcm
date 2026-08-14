import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST,
  type PostgreSqlRuntimePrivilegeEntry,
  type PostgreSqlRuntimePrivilegeKind,
} from "../../src/storage/postgresql/runtime-readiness.js";

const REFERENCE_DIRECTORY = join(
  process.cwd(),
  "src",
  "storage",
  "postgresql",
  "reference",
);

const REQUIRED_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
] as const;

const OPTIONAL_GRANT_SCRIPT = "postgresql-runtime-transcript-grants.sql";

function splitTopLevel(value: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function normalizeFunctionIdentity(value: string): string {
  const match = /^(?<name>[a-z_]+\.[a-z_]+)\((?<arguments>.*)\)$/iu.exec(value.trim());
  if (match?.groups === undefined) throw new Error(`Invalid function grant identity: ${value}`);
  const name = match.groups.name!.toLowerCase();
  const argumentTypes = splitTopLevel(match.groups.arguments!)
    .map((argument) => argument.replace(/\s+/gu, " ").trim());
  if (name === "lcm.normalize_search_text" && argumentTypes.join(", ") === "text") {
    return `${name}(input text)`;
  }
  return `${name}(${argumentTypes.join(", ")})`;
}

function key(
  kind: PostgreSqlRuntimePrivilegeKind,
  object: string,
  privilege: string,
  column?: string,
): string {
  return [kind, object, column ?? "", privilege].join("|");
}

function manifestKey(entry: PostgreSqlRuntimePrivilegeEntry): string {
  return key(entry.kind, entry.object, entry.privilege, entry.column);
}

function readGrantScript(filename: string): string {
  return readFileSync(join(REFERENCE_DIRECTORY, filename), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\"))
    .map((line) => line.replace(/--.*$/u, ""))
    .join("\n");
}

function parseGrantScript(filename: string): ReadonlySet<string> {
  const sql = readGrantScript(filename);
  const entries = new Set<string>();
  const grantStatementCount = [...sql.matchAll(/^\s*GRANT\b/gimu)].length;
  const statements = [...sql.matchAll(
    /GRANT\s+(?<privileges>[\s\S]*?)\s+ON\s+(?<kind>SCHEMA|TABLE|SEQUENCE|FUNCTION)\s+(?<objects>[\s\S]*?)\s+TO\s+:"lcm_runtime_role"\s*;/giu,
  )];
  if (statements.length !== grantStatementCount) {
    throw new Error(`Unable to parse every grant in ${filename}`);
  }
  for (const statement of statements) {
    const groups = statement.groups;
    if (groups === undefined) throw new Error(`Unable to parse grant in ${filename}`);
    const objectKind = groups.kind!.toUpperCase();
    const objects = splitTopLevel(groups.objects!).map((object) => (
      objectKind === "FUNCTION"
        ? normalizeFunctionIdentity(object)
        : object.replace(/\s+/gu, "")
    ));
    for (const privilegeSpec of splitTopLevel(groups.privileges!)) {
      const privilegeMatch = /^(?<privilege>[A-Z]+)(?:\s*\((?<columns>[\s\S]*)\))?$/iu
        .exec(privilegeSpec);
      if (privilegeMatch?.groups === undefined) {
        throw new Error(`Unable to parse privilege ${privilegeSpec} in ${filename}`);
      }
      const privilege = privilegeMatch.groups.privilege!.toUpperCase();
      const columns = privilegeMatch.groups.columns === undefined
        ? undefined
        : splitTopLevel(privilegeMatch.groups.columns).map((column) => (
          column.replace(/\s+/gu, "")
        ));
      for (const object of objects) {
        if (objectKind === "TABLE" && columns !== undefined) {
          for (const column of columns) entries.add(key("column", object, privilege, column));
        } else {
          const kind = objectKind === "TABLE"
            ? "relation"
            : objectKind.toLowerCase() as PostgreSqlRuntimePrivilegeKind;
          entries.add(key(kind, object, privilege));
        }
      }
    }
  }
  return entries;
}

function sorted(values: Iterable<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

describe("PostgreSQL runtime privilege manifest grant scripts", () => {
  it("is the exact deduplicated union of all required reviewed grant scripts", () => {
    const scriptEntries = new Set(
      REQUIRED_GRANT_SCRIPTS.flatMap((filename) => [...parseGrantScript(filename)]),
    );
    const manifestEntries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required.map(manifestKey);

    expect(new Set(manifestEntries).size).toBe(manifestEntries.length);
    expect(sorted(manifestEntries)).toEqual(sorted(scriptEntries));
    expect(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required.every((entry) => (
      entry.grantor === "object-owner"
    ))).toBe(true);
  });

  it("contains exactly the transcript-only delta as the sanctioned optional set", () => {
    const requiredEntries = new Set(
      REQUIRED_GRANT_SCRIPTS.flatMap((filename) => [...parseGrantScript(filename)]),
    );
    const transcriptOnlyEntries = new Set(
      [...parseGrantScript(OPTIONAL_GRANT_SCRIPT)].filter((entry) => !requiredEntries.has(entry)),
    );
    const optionalManifestEntries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional.map(manifestKey);

    expect(new Set(optionalManifestEntries).size).toBe(optionalManifestEntries.length);
    expect(sorted(optionalManifestEntries)).toEqual(sorted(transcriptOnlyEntries));
    expect(optionalManifestEntries.some((entry) => requiredEntries.has(entry))).toBe(false);
  });

  it("binds extension functions to their expected extension identities", () => {
    const functionEntries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
      .filter(({ kind }) => kind === "function");

    expect(functionEntries.map(({ object, extension = null }) => ({
      object,
      extension,
    }))).toEqual([
      { object: "lcm.normalize_search_text(input text)", extension: null },
      { object: "public.digest(text, text)", extension: "pgcrypto" },
      { object: "public.digest(bytea, text)", extension: "pgcrypto" },
      { object: "public.similarity(text, text)", extension: "pg_trgm" },
      { object: "public.similarity_op(text, text)", extension: "pg_trgm" },
    ]);
  });
});

import { createHash } from "node:crypto";
import { normalizeProjectPath } from "../../src/project-map.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { PostgreSqlQueryExecutor, PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import { PORTABLE_LIMITS, canonicalJson } from "../../src/storage/portable-record.js";

/**
 * Test oracle for #1869 slice 2: the destination identity fingerprint exactly
 * as portable-destination.ts computed it at 7790f1f3, one row per statement,
 * before its reads were fused. The SQL is frozen here as the shared mapping
 * generated it then, so a later change to portable-mapping.ts cannot move the
 * oracle along with the code it checks.
 */
type FrozenDomain = Readonly<{ table: string; keys: readonly string[]; joins: string; select: string }>;
const FROZEN_DOMAINS: Readonly<Record<"project" | "project-aliases", FrozenDomain>> = Object.freeze({
  project: { table: "lcm.projects", keys: ["project_id"], joins: "", select: "r.project_id::text AS project_id" },
  "project-aliases": {
    table: "lcm.project_aliases",
    keys: ["machine_id", "normalized_path"],
    joins: " JOIN lcm.machines m ON m.machine_id = r.machine_id",
    select: "r.machine_id::text AS machine_id, r.normalized_path AS normalized_path, r.path AS path, m.identity_key AS machine_identity_key",
  },
});

export class IdentityFingerprintOracleError extends Error {
  constructor(readonly code: "destination-conflict" | "unsupported-capability") {
    super(code);
  }
}

function keyExpression(domain: FrozenDomain, alias = "r"): string {
  return "ARRAY[" + domain.keys.map((key) => alias + "." + key + "::text COLLATE \"C\"").join(", ") + "]";
}
function sizeExpression(domain: FrozenDomain): string {
  return "(SELECT octet_length(row_to_json(portable_row)::text)::bigint FROM (SELECT " + domain.select + ") portable_row)";
}
function headersSql(domain: FrozenDomain): string {
  const locator = "CASE WHEN sized.byte_length <= $4::bigint THEN json_build_array("
    + domain.keys.map((key) => "sized." + key + "::text").join(", ") + ")::text ELSE '' END";
  return "SELECT page.locator, page.\"byteLength\" FROM (SELECT " + locator + " AS locator, sized.byte_length::text AS \"byteLength\", "
    + "row_number() OVER page_order AS page_row, sum(octet_length(" + locator + ")) OVER page_order AS page_bytes FROM (SELECT "
    + domain.keys.map((key) => "r." + key + "::text AS " + key).join(", ") + ", " + sizeExpression(domain) + " AS byte_length FROM "
    + domain.table + " r" + domain.joins + " WHERE (r.project_id = $1::uuid) AND ($2::text[] IS NULL OR " + keyExpression(domain)
    + " > $2::text[] COLLATE \"C\") ORDER BY " + keyExpression(domain) + " COLLATE \"C\" LIMIT $3) sized WINDOW page_order AS (ORDER BY "
    + keyExpression(domain, "sized") + " COLLATE \"C\" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) page "
    + "WHERE page.page_row = 1 OR page.page_bytes <= $4::bigint ORDER BY page.page_row";
}
function rowSql(domain: FrozenDomain): string {
  return "SELECT " + domain.select + " FROM " + domain.table + " r" + domain.joins + " WHERE (r.project_id = $1::uuid) AND "
    + keyExpression(domain) + " = $2::text[] COLLATE \"C\" AND " + sizeExpression(domain) + " <= $3::bigint LIMIT 1";
}
function parseLocator(locator: string, count: number): string[] {
  const parsed: unknown = JSON.parse(locator);
  if (!Array.isArray(parsed) || parsed.length !== count || !parsed.every((value) => typeof value === "string")) {
    throw new IdentityFingerprintOracleError("unsupported-capability");
  }
  return parsed as string[];
}

/** The pre-rewrite readIdentityFingerprint, statement for statement. */
export async function readIdentityFingerprintOracle(
  executor: PostgreSqlQueryExecutor,
  identity: StorageIdentityContext,
): Promise<string> {
  const options: PostgreSqlQueryOptions = { domain: "factory", operation: "identityFingerprintOracle", projectId: identity.id };
  const binding = await executor.query({
    text: "SELECT p.project_id::text FROM lcm.projects p JOIN lcm.project_aliases a ON a.project_id=p.project_id JOIN lcm.machines m ON m.machine_id=a.machine_id WHERE p.project_id=$1 AND a.machine_id=$2 AND a.path=$3 AND a.normalized_path=$4",
    values: [identity.id, identity.machineId, identity.selectedPath, normalizeProjectPath(identity.selectedPath!)],
  }, options);
  if (binding.rows.length !== 1) throw new IdentityFingerprintOracleError("destination-conflict");
  const digest = createHash("sha256");
  for (const name of ["project", "project-aliases"] as const) {
    const domain = FROZEN_DOMAINS[name];
    let after: string | null = null;
    for (;;) {
      const headers = await executor.query<{ locator: string; byteLength: string }>({
        text: headersSql(domain),
        values: [identity.id, after === null ? null : parseLocator(after, domain.keys.length), 1, String(PORTABLE_LIMITS.maxBatchBytes)],
      }, options);
      if (headers.rows.length === 0) break;
      const header = headers.rows[0]!;
      if (BigInt(header.byteLength) > BigInt(PORTABLE_LIMITS.maxBatchBytes)) throw new IdentityFingerprintOracleError("unsupported-capability");
      const row = await executor.query({
        text: rowSql(domain),
        values: [identity.id, parseLocator(header.locator, domain.keys.length), String(PORTABLE_LIMITS.maxBatchBytes)],
      }, options);
      if (row.rows.length === 0) throw new IdentityFingerprintOracleError("destination-conflict");
      digest.update(canonicalJson([name, row.rows[0]]));
      after = header.locator;
    }
  }
  let machineAfter = "";
  for (;;) {
    const result = await executor.query({
      text: "SELECT machine_id::text,CASE WHEN octet_length(identity_key)<=$2 THEN identity_key END AS identity_key FROM lcm.machines WHERE (machine_id=$3::uuid OR EXISTS (SELECT 1 FROM lcm.project_aliases a WHERE a.project_id=$4::uuid AND a.machine_id=lcm.machines.machine_id)) AND machine_id::text COLLATE \"C\">$1 COLLATE \"C\" ORDER BY machine_id::text COLLATE \"C\" LIMIT 1",
      values: [machineAfter, PORTABLE_LIMITS.maxControlBytes, identity.machineId, identity.id],
    }, options);
    if (result.rows.length === 0) break;
    const row = result.rows[0]!;
    if (typeof row.identity_key !== "string") throw new IdentityFingerprintOracleError("unsupported-capability");
    digest.update(canonicalJson(["machines", row]));
    machineAfter = String(row.machine_id);
  }
  return digest.digest("hex");
}

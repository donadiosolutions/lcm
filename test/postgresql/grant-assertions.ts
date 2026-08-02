import { expect } from "vitest";
import type { PostgreSqlTestDatabase } from "./harness.js";

/** Assert the shared fenced-lease admission read granted by a domain script. */
export async function assertFencedLeaseReadOnlyGrant(
  database: PostgreSqlTestDatabase,
  domain: string,
): Promise<void> {
  const result = await database.migrator.query<{
    lease_select: boolean;
    lease_insert: boolean;
    lease_update: boolean;
    lease_delete: boolean;
    lease_truncate: boolean;
    lease_grant_option: boolean;
    lease_foreign_grantor: boolean;
    lease_broader_acl: boolean;
    lease_sequence_usage: boolean;
    lease_sequence_select: boolean;
    lease_sequence_update: boolean;
  }>({
    text: `SELECT
             has_table_privilege(
               'lcm_test_runtime', 'lcm.fenced_leases', 'SELECT'
             ) AS lease_select,
             has_table_privilege(
               'lcm_test_runtime', 'lcm.fenced_leases', 'INSERT'
             ) AS lease_insert,
             has_table_privilege(
               'lcm_test_runtime', 'lcm.fenced_leases', 'UPDATE'
             ) AS lease_update,
             has_table_privilege(
               'lcm_test_runtime', 'lcm.fenced_leases', 'DELETE'
             ) AS lease_delete,
             has_table_privilege(
               'lcm_test_runtime', 'lcm.fenced_leases', 'TRUNCATE'
             ) AS lease_truncate,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_class AS relation
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 COALESCE(
                   relation.relacl,
                   pg_catalog.acldefault('r', relation.relowner)
                 )
               ) AS privilege
               WHERE relation.oid = 'lcm.fenced_leases'::pg_catalog.regclass
                 AND privilege.grantee = 'lcm_test_runtime'::pg_catalog.regrole
                 AND privilege.is_grantable
             ) AS lease_grant_option,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_class AS relation
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 COALESCE(
                   relation.relacl,
                   pg_catalog.acldefault('r', relation.relowner)
                 )
               ) AS privilege
               WHERE relation.oid = 'lcm.fenced_leases'::pg_catalog.regclass
                 AND privilege.grantee = 'lcm_test_runtime'::pg_catalog.regrole
                 AND privilege.grantor <> relation.relowner
             ) AS lease_foreign_grantor,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_class AS relation
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 COALESCE(
                   relation.relacl,
                   pg_catalog.acldefault('r', relation.relowner)
                 )
               ) AS privilege
               WHERE relation.oid = 'lcm.fenced_leases'::pg_catalog.regclass
                 AND privilege.grantee = 'lcm_test_runtime'::pg_catalog.regrole
                 AND privilege.privilege_type
                   OPERATOR(pg_catalog.<>) 'SELECT'
             ) AS lease_broader_acl,
             has_sequence_privilege(
               'lcm_test_runtime',
               'lcm.fenced_leases_fencing_token_seq',
               'USAGE'
             ) AS lease_sequence_usage,
             has_sequence_privilege(
               'lcm_test_runtime',
               'lcm.fenced_leases_fencing_token_seq',
               'SELECT'
             ) AS lease_sequence_select,
             has_sequence_privilege(
               'lcm_test_runtime',
               'lcm.fenced_leases_fencing_token_seq',
               'UPDATE'
             ) AS lease_sequence_update`,
  }, { domain, operation: "inspectFencedLeaseReadOnlyGrant" });
  expect(result.rows[0]).toEqual({
    lease_select: true,
    lease_insert: false,
    lease_update: false,
    lease_delete: false,
    lease_truncate: false,
    lease_grant_option: false,
    lease_foreign_grantor: false,
    lease_broader_acl: false,
    lease_sequence_usage: false,
    lease_sequence_select: false,
    lease_sequence_update: false,
  });
}

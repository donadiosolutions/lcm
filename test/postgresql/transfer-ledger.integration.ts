import { beforeAll, describe, expect, it } from "vitest";
import type { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { assertHarnessReady, withPostgreSqlTestDatabase } from "./harness.js";

beforeAll(assertHarnessReady);
const sha = "a".repeat(64);
const otherSha = "b".repeat(64);
const options = { domain: "factory", operation: "testTransferLedger" } as const;

async function seedRun(runtime: PostgreSqlRuntime): Promise<string> {
  const project = await runtime.query<{ project_id: string }>({
    text: "INSERT INTO lcm.projects (identity_key,display_name) VALUES ($1,'Transfer project') RETURNING project_id",
    values: [sha],
  }, options);
  const projectId = project.rows[0]!.project_id;
  await runtime.query({
    text: `INSERT INTO lcm.transfer_runs
      (run_id,target_generation,project_id,manifest_bytes,manifest_sha256,
       schema_sha256,project_sha256,source_sha256,source_witness_sha256,state)
      VALUES ('run','generation',$1,$2,$3,$3,$3,$3,$3,'active')`,
    values: [projectId, Buffer.from('{"protocol":"manifest"}'), sha],
  }, options);
  return projectId;
}

const insertBatch = `INSERT INTO lcm.transfer_batches
  (run_id,domain,prior_checkpoint_sha256,batch_sha256,checkpoint_bytes,
   checkpoint_sha256,first_ordinal,next_ordinal)
  VALUES ('run','messages',$1,$2,$3,$4,$5,$6)`;
const insertIdentity = `INSERT INTO lcm.transfer_identities
  (run_id,domain,identity_sha256,ordinal,native_key,record_sha256)
  VALUES ('run','messages',$1,$2,'native-key',$3)`;

describe("PostgreSQL transfer ledger", () => {
  it("keeps exact receipt bytes, supports empty ranges and rejects conflicting replay keys", async () => {
    await withPostgreSqlTestDatabase("transfer-receipts", async ({ migrator }) => {
      await seedRun(migrator);
      const bytes = Buffer.from('{"checkpointSha256":"protocol-hash"}');
      await migrator.query({ text: insertBatch, values: [sha, sha, bytes, otherSha, "9007199254740993", "9007199254740993"] }, options);
      const receipt = await migrator.query<{ checkpoint_bytes: Buffer; first_ordinal: string; next_ordinal: string }>({
        text: "SELECT checkpoint_bytes,first_ordinal,next_ordinal FROM lcm.transfer_batches",
      }, options);
      expect(receipt.rows).toEqual([{ checkpoint_bytes: bytes, first_ordinal: "9007199254740993", next_ordinal: "9007199254740993" }]);
      for (const values of [
        [sha, otherSha, bytes, sha, "0", "1"],
        [otherSha, sha, bytes, otherSha, "0", "1"],
        [otherSha, sha, bytes, sha, "2", "1"],
        [otherSha, sha, bytes, sha, "-1", "0"],
      ]) {
        await expect(migrator.query({ text: insertBatch, values }, options)).rejects.toMatchObject({ backend: "postgresql" });
      }
      const count = await migrator.query<{ count: string }>({ text: "SELECT count(*) FROM lcm.transfer_batches" }, options);
      expect(count.rows[0]?.count).toBe("1");
    });
  });

  it("rejects duplicate logical identities and ordinals without storing record payloads", async () => {
    await withPostgreSqlTestDatabase("transfer-identities", async ({ migrator }) => {
      await seedRun(migrator);
      await migrator.query({ text: insertIdentity, values: [sha, "0", sha] }, options);
      for (const values of [[sha, "1", otherSha], [otherSha, "0", sha], [otherSha, "-1", sha]]) {
        await expect(migrator.query({ text: insertIdentity, values }, options)).rejects.toMatchObject({ backend: "postgresql" });
      }
      const rows = await migrator.query({ text: "SELECT * FROM lcm.transfer_identities" }, options);
      expect(rows.rows).toEqual([{ run_id: "run", domain: "messages", identity_sha256: sha, ordinal: "0", native_key: "native-key", record_sha256: sha }]);
    });
  });

  it("binds one run to each target/project and rolls receipt progress back atomically", async () => {
    await withPostgreSqlTestDatabase("transfer-atomicity", async ({ migrator }) => {
      const projectId = await seedRun(migrator);
      await expect(migrator.query({
        text: `INSERT INTO lcm.transfer_runs
          SELECT 'other',target_generation,project_id,manifest_bytes,manifest_sha256,
                 schema_sha256,project_sha256,source_sha256,source_witness_sha256,state,
                 current_domain,checkpoint_bytes,checkpoint_sha256,created_at
          FROM lcm.transfer_runs WHERE project_id=$1`,
        values: [projectId],
      }, options)).rejects.toMatchObject({ backend: "postgresql" });
      await expect(migrator.query({ text: "UPDATE lcm.transfer_runs SET checkpoint_bytes='bytes'::bytea" }, options))
        .rejects.toMatchObject({ backend: "postgresql" });
      await expect(migrator.transaction(async (transaction) => {
        await transaction.query({ text: insertBatch, values: [sha, sha, Buffer.from("checkpoint"), sha, "0", "1"] }, options);
        await transaction.query({ text: insertIdentity, values: [sha, "0", sha] }, options);
        await transaction.query({ text: "UPDATE lcm.transfer_runs SET current_domain='messages'" }, options);
        throw new Error("injected before commit");
      }, { ...options, mode: "read-committed-read-write" })).rejects.toThrow();
      const state = await migrator.query({ text: `SELECT current_domain,
        (SELECT count(*) FROM lcm.transfer_batches)::int AS batches,
        (SELECT count(*) FROM lcm.transfer_identities)::int AS identities
        FROM lcm.transfer_runs` }, options);
      expect(state.rows).toEqual([{ current_domain: null, batches: 0, identities: 0 }]);
    });
  });
});

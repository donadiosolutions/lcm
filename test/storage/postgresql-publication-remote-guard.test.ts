import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgreSqlTransactionScopeExecutor } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlBackendPublicationGuard,
  type PostgreSqlBackendPublicationControlExecutor,
  type PostgreSqlBackendPublicationFence,
} from "../../src/storage/postgresql/publication-guard.js";
import {
  createPostgreSqlBackendPublicationRemoteGuard,
  type PostgreSqlBackendPublicationRemoteGuardPort,
} from "../../src/storage/postgresql/publication-remote-guard.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { composeBackendPublicationMaterial } from "../../src/storage/backend-publication-material.js";
import type { BackendPublicationRemoteContext } from "../../src/storage/backend-publication.js";

const PROJECT = "018f0000-0000-7000-8000-000000000001";
const MACHINE = "018f0000-0000-7000-8000-000000000002";
const OTHER_MACHINE = "018f0000-0000-7000-8000-000000000003";
const PUBLICATION = "pub-remote-guard";
const OTHER_PUBLICATION = "pub-someone-else";
const EVIDENCE = "a".repeat(64);
const OTHER_EVIDENCE = "b".repeat(64);
const TTL_MS = 60_000;
const HASH_A = "a".repeat(64);

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

type LeaseRow = {
  machineId: string;
  publicationId: string;
  targetBackend: "postgresql" | "sqlite";
  evidenceSha256: string;
  token: number;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
  releasedAtMs: number | null;
};

/**
 * A one-row stand-in for lcm.fenced_leases that answers the exact statements
 * PostgreSqlBackendPublicationGuard issues, so the REAL guard code (its
 * same-generation, expectedFencingToken and release rules) runs under the
 * provider.
 */
class FenceTable {
  row: LeaseRow | null = null;
  nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  nextToken = 1;
  writes = 0;

  private view(expired: boolean): QueryResultRow {
    const row = this.row!;
    return {
      project_id: PROJECT,
      owner_machine_id: row.machineId,
      owner_process_id: row.publicationId,
      operation: `backend-publication:${row.targetBackend}:${row.evidenceSha256}`,
      fencing_token: String(row.token),
      acquired_at: new Date(row.acquiredAtMs).toISOString(),
      renewed_at: new Date(row.renewedAtMs).toISOString(),
      expires_at: new Date(row.expiresAtMs).toISOString(),
      released_at: row.releasedAtMs === null ? null : new Date(row.releasedAtMs).toISOString(),
      expired,
    };
  }

  select(): QueryResultRow[] {
    return this.row === null ? [] : [this.view(this.row.expiresAtMs <= this.nowMs)];
  }

  handle(config: QueryConfig<unknown[]>): QueryResultRow[] {
    const values = config.values ?? [];
    if (config.text.includes("FOR UPDATE")) return this.row === null ? [] : [this.view(false)];
    if (config.text.startsWith("INSERT INTO lcm.fenced_leases")) {
      this.writes += 1;
      this.row = this.fresh(values);
      return [this.view(false)];
    }
    if (config.text.includes("fencing_token = DEFAULT")) {
      if (this.row === null || String(this.row.token) !== values[7]) return [];
      this.writes += 1;
      this.row = this.fresh(values);
      return [this.view(false)];
    }
    if (config.text.includes("released_at = GREATEST")) {
      const row = this.row;
      const [, , , machine, publication, operation, token] = values;
      if (
        row === null
        || row.machineId !== machine
        || row.publicationId !== publication
        || `backend-publication:${row.targetBackend}:${row.evidenceSha256}` !== operation
        || String(row.token) !== token
        || row.releasedAtMs !== null
        || row.expiresAtMs <= this.nowMs
      ) return [];
      this.writes += 1;
      row.releasedAtMs = Math.max(this.nowMs, row.renewedAtMs);
      return [this.view(false)];
    }
    return this.select();
  }

  private fresh(values: unknown[]): LeaseRow {
    const identity = /^backend-publication:(postgresql|sqlite):([0-9a-f]{64})$/u.exec(String(values[5]))!;
    const token = this.nextToken;
    this.nextToken += 1;
    return {
      machineId: String(values[3]),
      publicationId: String(values[4]),
      targetBackend: identity[1] as "postgresql" | "sqlite",
      evidenceSha256: identity[2]!,
      token,
      acquiredAtMs: this.nowMs,
      renewedAtMs: this.nowMs,
      expiresAtMs: this.nowMs + Number(values[6]),
      releasedAtMs: null,
    };
  }

  seed(row: Partial<LeaseRow> = {}): void {
    const token = this.nextToken;
    this.nextToken += 1;
    this.row = {
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      token,
      acquiredAtMs: this.nowMs,
      renewedAtMs: this.nowMs,
      expiresAtMs: this.nowMs + TTL_MS,
      releasedAtMs: null,
      ...row,
    };
  }

  expire(): void {
    this.nowMs = this.row!.expiresAtMs + 1;
  }

  executor(): PostgreSqlBackendPublicationControlExecutor {
    const transaction = (): PostgreSqlTransactionScopeExecutor => {
      const query = async <R extends QueryResultRow = QueryResultRow>(config: QueryConfig<unknown[]>) =>
        result(this.handle(config)) as unknown as QueryResult<R>;
      return { transactionScope: "active", query, savepoint: async (callback) => callback({ query }) } as never;
    };
    return {
      projectPublicationTransaction: async (_projectId: string, callback: (scope: PostgreSqlTransactionScopeExecutor) => Promise<unknown>) =>
        callback(transaction()),
      projectPublicationReadback: async () => result(this.select()),
    } as unknown as PostgreSqlBackendPublicationControlExecutor;
  }
}

function context(): BackendPublicationRemoteContext {
  return {
    homeDir: undefined,
    journal: { publicationId: PUBLICATION, targetBackend: "postgresql" },
    project: {
      localProjectId: HASH_A,
      remoteProjectId: PROJECT,
      evidenceSha256: EVIDENCE,
      fence: null,
    },
  } as never;
}

function providerOver(table: FenceTable, machineId = MACHINE) {
  return createPostgreSqlBackendPublicationRemoteGuard({
    guard: new PostgreSqlBackendPublicationGuard(table.executor()),
    machineId,
    ttlMs: TTL_MS,
  });
}

describe("createPostgreSqlBackendPublicationRemoteGuard row states", () => {
  it("reads no row as null", async () => {
    await expect(providerOver(new FenceTable()).readRemoteGuard(context(), "acquire")).resolves.toBeNull();
  });

  it("reads an active row of this generation with the token as a decimal string", async () => {
    const table = new FenceTable();
    table.seed();
    const fence = await providerOver(table).readRemoteGuard(context(), "acquire");
    expect(fence).toEqual({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      fencingToken: "1",
      acquiredAt: "2026-08-01T00:00:00.000Z",
      renewedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:01:00.000Z",
      releasedAt: null,
      databaseExpired: false,
    });
  });

  it("reports a row of another publication as-is so the coordinator can reject its identity", async () => {
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE, publicationId: OTHER_PUBLICATION });
    const fence = await providerOver(table).readRemoteGuard(context(), "acquire");
    expect(fence?.publicationId).toBe(OTHER_PUBLICATION);
    expect(fence?.machineId).toBe(OTHER_MACHINE);
  });

  it("refuses to read a row of this publication that another machine holds", async () => {
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE });
    await expect(providerOver(table).readRemoteGuard(context(), "release")).rejects.toMatchObject({
      reason: "publication-conflict",
    });
  });

  it("propagates the guard's fence-mismatch when reading for release a row that names another target or evidence", async () => {
    const table = new FenceTable();
    table.seed({ evidenceSha256: OTHER_EVIDENCE });
    await expect(providerOver(table).readRemoteGuard(context(), "release")).rejects.toMatchObject({
      reason: "fence-mismatch",
    });
    table.seed({ targetBackend: "sqlite" });
    await expect(providerOver(table).readRemoteGuard(context(), "release")).rejects.toMatchObject({
      reason: "fence-mismatch",
    });
  });

  it("treats a row that names another target or evidence as no usable row when reading to acquire", async () => {
    const table = new FenceTable();
    table.seed({ evidenceSha256: OTHER_EVIDENCE });
    await expect(providerOver(table).readRemoteGuard(context(), "acquire")).resolves.toBeNull();
    table.seed({ targetBackend: "sqlite" });
    await expect(providerOver(table).readRemoteGuard(context(), "acquire")).resolves.toBeNull();
  });

  it("acquires a new generation over a released row that named different evidence", async () => {
    const table = new FenceTable();
    table.seed({ evidenceSha256: OTHER_EVIDENCE, releasedAtMs: Date.parse("2026-08-01T00:00:30.000Z") });
    const fence = await providerOver(table).acquireRemoteGuard(context());
    expect(fence).toMatchObject({ evidenceSha256: EVIDENCE, fencingToken: "2", releasedAt: null, machineId: MACHINE });
    expect(table.row).toMatchObject({ evidenceSha256: EVIDENCE, token: 2, releasedAtMs: null });
  });

  it("acquires a new generation over a released row that named a different target backend", async () => {
    const table = new FenceTable();
    table.seed({ targetBackend: "sqlite", releasedAtMs: Date.parse("2026-08-01T00:00:30.000Z") });
    const fence = await providerOver(table).acquireRemoteGuard(context());
    expect(fence).toMatchObject({ targetBackend: "postgresql", fencingToken: "2", releasedAt: null });
  });

  it("refuses with publication-conflict, leaving the row, when an unreleased row names different evidence or target", async () => {
    for (const other of [{ evidenceSha256: OTHER_EVIDENCE }, { targetBackend: "sqlite" as const }]) {
      const table = new FenceTable();
      table.seed({ machineId: OTHER_MACHINE, publicationId: OTHER_PUBLICATION, ...other });
      const before = { ...table.row! };
      await expect(providerOver(table).acquireRemoteGuard(context())).rejects.toMatchObject({
        reason: "publication-conflict",
      });
      expect(table.writes).toBe(0);
      expect(table.row).toEqual(before);
    }
  });

  it("returns a released foreign row unchanged and reclaims it on acquire", async () => {
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE, releasedAtMs: Date.parse("2026-08-01T00:00:30.000Z") });
    const provider = providerOver(table);
    await expect(provider.readRemoteGuard(context(), "acquire")).resolves.toMatchObject({
      machineId: OTHER_MACHINE,
      releasedAt: expect.any(String),
    });
    const fence = await provider.acquireRemoteGuard(context());
    expect(fence).toMatchObject({ machineId: MACHINE, fencingToken: "2", releasedAt: null });
  });

  it("returns an expired foreign row unchanged; acquiring over it is the guard's conflict", async () => {
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE });
    table.expire();
    const provider = providerOver(table);
    await expect(provider.readRemoteGuard(context(), "acquire")).resolves.toMatchObject({
      machineId: OTHER_MACHINE,
      databaseExpired: true,
    });
    await expect(provider.acquireRemoteGuard(context())).rejects.toMatchObject({
      reason: "publication-conflict",
    });
    expect(table.writes).toBe(0);
  });

  it("acquires when no row exists", async () => {
    const table = new FenceTable();
    const fence = await providerOver(table).acquireRemoteGuard(context());
    expect(fence).toMatchObject({ fencingToken: "1", releasedAt: null, databaseExpired: false, machineId: MACHINE });
    expect(table.writes).toBe(1);
  });

  it("adopts an unexpired lease of this generation unchanged", async () => {
    const table = new FenceTable();
    table.seed();
    const fence = await providerOver(table).acquireRemoteGuard(context());
    expect(fence.fencingToken).toBe("1");
    expect(table.writes).toBe(0);
    expect(table.row?.token).toBe(1);
  });

  it("takes over an expired lease of this generation with the row's own token", async () => {
    const table = new FenceTable();
    table.seed();
    table.expire();
    const fence = await providerOver(table).acquireRemoteGuard(context());
    expect(fence).toMatchObject({ fencingToken: "2", releasedAt: null, databaseExpired: false });
    expect(table.row?.token).toBe(2);
  });

  it("takes over from the authoritative row, not from a stale token the journal recorded", async () => {
    const table = new FenceTable();
    table.nextToken = 5;
    table.seed();
    table.expire();
    const stale = context();
    (stale.project as { fence: unknown }).fence = { fencingToken: "2" };
    const fence = await providerOver(table).acquireRemoteGuard(stale);
    expect(fence.fencingToken).toBe("6");
  });

  it("acquires a fresh generation over a released row without a takeover token", async () => {
    const table = new FenceTable();
    table.seed({ releasedAtMs: Date.parse("2026-08-01T00:00:30.000Z") });
    const fence = await providerOver(table).acquireRemoteGuard(context());
    expect(fence).toMatchObject({ fencingToken: "2", releasedAt: null });
  });

  it("propagates publication-conflict for an unreleased row of a different generation", async () => {
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE, publicationId: OTHER_PUBLICATION });
    await expect(providerOver(table).acquireRemoteGuard(context())).rejects.toMatchObject({
      reason: "publication-conflict",
    });
    expect(table.writes).toBe(0);
  });

  it("does not take over an expired row of a different generation", async () => {
    const table = new FenceTable();
    table.seed({ publicationId: OTHER_PUBLICATION });
    table.expire();
    await expect(providerOver(table).acquireRemoteGuard(context())).rejects.toMatchObject({
      reason: "publication-conflict",
    });
    expect(table.writes).toBe(0);
  });

  it("refuses to acquire over a row of this publication that another machine holds", async () => {
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE });
    await expect(providerOver(table).acquireRemoteGuard(context())).rejects.toMatchObject({
      reason: "publication-conflict",
    });
    expect(table.writes).toBe(0);
  });

  it("releases the fence it names and leaves the row released", async () => {
    const table = new FenceTable();
    table.seed();
    const provider = providerOver(table);
    const fence = (await provider.readRemoteGuard(context(), "release"))!;
    await provider.releaseRemoteGuard({ ...context(), fence });
    expect(table.row?.releasedAtMs).not.toBeNull();
    const after = await provider.readRemoteGuard(context(), "release");
    expect(after?.releasedAt).not.toBeNull();
    expect(after?.fencingToken).toBe("1");
  });

  it("propagates the guard's fence-mismatch when asked to release a superseded token", async () => {
    const table = new FenceTable();
    table.seed();
    const provider = providerOver(table);
    const fence = (await provider.readRemoteGuard(context(), "release"))!;
    await expect(provider.releaseRemoteGuard({
      ...context(),
      fence: { ...fence, fencingToken: "9" },
    })).rejects.toMatchObject({ reason: "fence-mismatch" });
    expect(table.row?.releasedAtMs).toBeNull();
  });
});

describe("createPostgreSqlBackendPublicationRemoteGuard against a guard double", () => {
  function guardDouble(
    overrides: Partial<PostgreSqlBackendPublicationRemoteGuardPort> = {},
  ): PostgreSqlBackendPublicationRemoteGuardPort {
    return {
      acquire: vi.fn(),
      read: vi.fn(async () => null),
      release: vi.fn(),
      ...overrides,
    } as unknown as PostgreSqlBackendPublicationRemoteGuardPort;
  }

  function fenceOf(overrides: Partial<PostgreSqlBackendPublicationFence> = {}): PostgreSqlBackendPublicationFence {
    return {
      projectId: PROJECT,
      machineId: OTHER_MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      fencingToken: 3n,
      acquiredAt: "2026-08-01T00:00:00.000Z",
      renewedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:01:00.000Z",
      releasedAt: null,
      databaseExpired: false,
      ...overrides,
    };
  }

  function providerWith(guard: PostgreSqlBackendPublicationRemoteGuardPort) {
    return createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId: MACHINE, ttlMs: TTL_MS });
  }

  it("refuses an acquisition result that another machine holds as the active fence of this publication", async () => {
    const provider = providerWith(guardDouble({ acquire: vi.fn(async () => fenceOf()) }));
    await expect(provider.acquireRemoteGuard(context())).rejects.toMatchObject({
      reason: "publication-conflict",
    });
  });

  it("refuses a foreign row only when the coordinator would accept it as the active fence", async () => {
    const accepted: Partial<PostgreSqlBackendPublicationFence>[] = [
      { releasedAt: "2026-08-01T00:00:30.000Z" },
      { databaseExpired: true },
      { publicationId: OTHER_PUBLICATION },
      { targetBackend: "sqlite" },
      { evidenceSha256: OTHER_EVIDENCE },
    ];
    for (const overrides of accepted) {
      const foreign = fenceOf(overrides);
      const provider = providerWith(guardDouble({ read: vi.fn(async () => foreign) }));
      await expect(provider.readRemoteGuard(context(), "release")).resolves.toMatchObject({
        machineId: OTHER_MACHINE,
        fencingToken: "3",
      });
    }
    const provider = providerWith(guardDouble({ read: vi.fn(async () => fenceOf()) }));
    await expect(provider.readRemoteGuard(context(), "release")).rejects.toMatchObject({
      reason: "publication-conflict",
    });
  });

  it("propagates every read error other than a fence-mismatch, on both paths", async () => {
    const { PostgreSqlBackendPublicationGuardError } = await import(
      "../../src/storage/postgresql/publication-guard.js"
    );
    for (const error of [
      new PostgreSqlBackendPublicationGuardError(PROJECT, "readBackendPublication", "invalid-row"),
      new Error("connection lost"),
    ]) {
      const provider = providerWith(guardDouble({ read: vi.fn(async () => { throw error; }) }));
      await expect(provider.readRemoteGuard(context(), "acquire")).rejects.toBe(error);
      await expect(provider.acquireRemoteGuard(context())).rejects.toBe(error);
      await expect(provider.readRemoteGuard(context(), "release")).rejects.toBe(error);
    }
  });

  it("passes the exact release identity with the token as a bigint and the machine id lowercased", async () => {
    const release = vi.fn(async () => ({}) as PostgreSqlBackendPublicationFence);
    const provider = createPostgreSqlBackendPublicationRemoteGuard({
      guard: guardDouble({ release }),
      machineId: MACHINE.toUpperCase(),
      ttlMs: TTL_MS,
    });
    await provider.releaseRemoteGuard({
      ...context(),
      fence: { fencingToken: "12" } as never,
    });
    expect(release).toHaveBeenCalledWith({
      projectId: PROJECT,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      fencingToken: 12n,
    });
  });
});

describe("createPostgreSqlBackendPublicationRemoteGuard release reconciliation read (Bug #1651)", () => {
  it("returns the row whichever generation it names, without refusing another machine", async () => {
    const provider = providerOver(new FenceTable());
    await expect(provider.readRemoteGuardForReleaseReconciliation!(context())).resolves.toBeNull();

    const table = new FenceTable();
    for (const row of [
      { machineId: OTHER_MACHINE, publicationId: OTHER_PUBLICATION },
      { evidenceSha256: OTHER_EVIDENCE },
      { targetBackend: "sqlite" as const },
      { machineId: OTHER_MACHINE },
      { releasedAtMs: table.nowMs },
    ]) {
      table.seed(row);
      const fence = await providerOver(table).readRemoteGuardForReleaseReconciliation!(context());
      expect(fence).toMatchObject({
        projectId: PROJECT,
        machineId: row.machineId ?? MACHINE,
        fencingToken: String(table.row!.token),
        releasedAt: "releasedAtMs" in row ? "2026-08-01T00:00:00.000Z" : null,
      });
    }
  });

  it("declares the capability only when the guard offers the read, and passes the remote project id", async () => {
    const base = { acquire: vi.fn(), read: vi.fn(), release: vi.fn() };
    const without = createPostgreSqlBackendPublicationRemoteGuard({ guard: base as never, machineId: MACHINE, ttlMs: TTL_MS });
    expect("readRemoteGuardForReleaseReconciliation" in without).toBe(false);

    const readForReleaseReconciliation = vi.fn(async () => null);
    const guard = { ...base, readForReleaseReconciliation };
    const provider = createPostgreSqlBackendPublicationRemoteGuard({ guard: guard as never, machineId: MACHINE, ttlMs: TTL_MS });
    await expect(provider.readRemoteGuardForReleaseReconciliation!(context())).resolves.toBeNull();
    expect(readForReleaseReconciliation).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(base.read).not.toHaveBeenCalled();
  });
});

describe("createPostgreSqlBackendPublicationRemoteGuard construction", () => {
  const guard = (): PostgreSqlBackendPublicationRemoteGuardPort => ({
    acquire: vi.fn(),
    read: vi.fn(),
    release: vi.fn(),
  }) as never;

  it("refuses missing options and a missing or incomplete guard", () => {
    expect(() => createPostgreSqlBackendPublicationRemoteGuard(undefined as never)).toThrow(
      /requires a guard object/,
    );
    expect(() => createPostgreSqlBackendPublicationRemoteGuard({
      guard: null as never,
      machineId: MACHINE,
      ttlMs: TTL_MS,
    })).toThrow(/requires a guard object/);
    for (const method of ["acquire", "read", "release"] as const) {
      expect(() => createPostgreSqlBackendPublicationRemoteGuard({
        guard: { ...guard(), [method]: undefined } as never,
        machineId: MACHINE,
        ttlMs: TTL_MS,
      })).toThrow(new RegExp(`missing required method: ${method}`));
    }
  });

  it("refuses a machine id that is not a UUIDv7", () => {
    for (const machineId of ["", "not-a-uuid", "018f0000-0000-4000-8000-000000000002", 7 as never]) {
      expect(() => createPostgreSqlBackendPublicationRemoteGuard({
        guard: guard(),
        machineId,
        ttlMs: TTL_MS,
      })).toThrow(/machineId must be a UUIDv7/);
    }
  });

  it("refuses a ttl outside the guard's accepted range", () => {
    for (const ttlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001, "5" as never]) {
      expect(() => createPostgreSqlBackendPublicationRemoteGuard({
        guard: guard(),
        machineId: MACHINE,
        ttlMs,
      })).toThrow(/ttlMs must be an integer from 1 to 86400000/);
    }
  });

  it("accepts exactly what the real guard accepts for machine id and ttl", async () => {
    const sentinel = new Error("reached the executor");
    const realGuard = new PostgreSqlBackendPublicationGuard({
      projectPublicationTransaction: async () => { throw sentinel; },
      projectPublicationReadback: async () => { throw sentinel; },
    } as never);
    const guardAccepts = async (machineId: unknown, ttlMs: unknown): Promise<boolean> => {
      try {
        await realGuard.acquire({
          projectId: PROJECT,
          machineId: machineId as string,
          publicationId: PUBLICATION,
          targetBackend: "postgresql",
          evidenceSha256: EVIDENCE,
          ttlMs: ttlMs as number,
        });
        return true;
      } catch (error) {
        return error === sentinel;
      }
    };
    const providerAccepts = (machineId: unknown, ttlMs: unknown): boolean => {
      try {
        createPostgreSqlBackendPublicationRemoteGuard({
          guard: guard(),
          machineId: machineId as string,
          ttlMs: ttlMs as number,
        });
        return true;
      } catch {
        return false;
      }
    };
    const machines = [MACHINE, MACHINE.toUpperCase(), "018f0000-0000-4000-8000-000000000002", "", "x", 5];
    const ttls = [1, TTL_MS, 86_400_000, 86_400_001, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", 2 ** 53];
    for (const machineId of machines) {
      expect(providerAccepts(machineId, TTL_MS)).toBe(await guardAccepts(machineId, TTL_MS));
    }
    for (const ttlMs of ttls) {
      expect(providerAccepts(MACHINE, ttlMs)).toBe(await guardAccepts(MACHINE, ttlMs));
    }
  });
});

describe("composition: real coordinator, driver, provider and guard over a fence table", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "lcm-publication-remote-guard-"));
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    roots.push(home);
    writeFileSync(
      join(home, ".lcm", "config.json"),
      `${JSON.stringify({ storage: { backend: "sqlite" }, keep: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, ".lcm", "map.json"),
      `${JSON.stringify({ [HASH_A]: { canonical: "/repos/one", aliases: [] } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return home;
  }

  const binding = {
    localProjectId: HASH_A,
    remoteProjectId: PROJECT,
    evidenceSha256: EVIDENCE,
  };

  function read(home: string, name: "config.json" | "map.json"): Record<string, any> {
    return JSON.parse(readFileSync(join(home, ".lcm", name), "utf-8"));
  }

  it("activates a project through prepare and resume, then rolls it back through prepare and abort", async () => {
    const home = makeHome();
    const table = new FenceTable();
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: providerOver(table) },
    });

    const activation = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding] });
    await coordinator.prepare({
      publicationId: PUBLICATION,
      sourceBackend: activation.sourceBackend,
      targetBackend: activation.targetBackend,
      material: activation.material,
      projects: activation.projects,
    });
    const completed = await coordinator.resume();
    expect(completed.phase).toBe("completed");
    expect(completed.projects[0]?.fence).toMatchObject({ fencingToken: "1", machineId: MACHINE });
    expect(table.row?.releasedAtMs).not.toBeNull();
    expect(read(home, "config.json").storage.backend).toBe("postgresql");
    expect(read(home, "map.json")[HASH_A].remoteProjectId).toBe(PROJECT);

    const rollback = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "sqlite", bindings: [binding] });
    expect(rollback.sourceBackend).toBe("postgresql");
    await coordinator.prepare({
      publicationId: "pub-rollback-attempt",
      sourceBackend: rollback.sourceBackend,
      targetBackend: rollback.targetBackend,
      material: rollback.material,
      projects: rollback.projects,
    });
    const aborted = await coordinator.abort();
    expect(aborted.phase).toBe("aborted");
    expect(read(home, "config.json").storage.backend).toBe("postgresql");
    expect(read(home, "map.json")[HASH_A].remoteProjectId).toBe(PROJECT);
    expect(table.row?.releasedAtMs).not.toBeNull();
  });

  it("adopts the lease the consumer acquired before driving the coordinator", async () => {
    const home = makeHome();
    const table = new FenceTable();
    const guard = new PostgreSqlBackendPublicationGuard(table.executor());
    await guard.acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: TTL_MS,
    });
    const writesBefore = table.writes;
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: providerOver(table) },
    });
    const composed = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding] });
    await coordinator.prepare({
      publicationId: PUBLICATION,
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    });
    const completed = await coordinator.resume();
    expect(completed.phase).toBe("completed");
    // Adoption is a read, and the only write after it is the release.
    expect(table.writes).toBe(writesBefore + 1);
    expect(completed.projects[0]?.fence?.fencingToken).toBe("1");
  });

  it("takes over its own lease when it lapses before the coordinator releases it", async () => {
    const home = makeHome();
    const table = new FenceTable();
    const provider = providerOver(table);
    const lapse = () => {
      if (table.row !== null && table.row.releasedAtMs === null && table.row.token === 1) table.expire();
    };
    const lapsing = {
      ...provider,
      readRemoteGuard: async (ctx: BackendPublicationRemoteContext, operation: "acquire" | "release") => {
        if (operation === "release") lapse();
        return provider.readRemoteGuard(ctx, operation);
      },
      readRemoteGuardForReleaseReconciliation: async (ctx: BackendPublicationRemoteContext) => {
        lapse();
        return provider.readRemoteGuardForReleaseReconciliation!(ctx);
      },
    };
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: lapsing },
    });
    const composed = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding] });
    await coordinator.prepare({
      publicationId: PUBLICATION,
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    });
    const completed = await coordinator.resume();
    expect(completed.phase).toBe("completed");
    expect(completed.projects[0]?.fence?.fencingToken).toBe("2");
    expect(table.row).toMatchObject({ token: 2 });
    expect(table.row?.releasedAtMs).not.toBeNull();
  });

  it("publishes over a released prior generation that named different evidence", async () => {
    const home = makeHome();
    const table = new FenceTable();
    table.seed({ evidenceSha256: OTHER_EVIDENCE, releasedAtMs: Date.parse("2026-08-01T00:00:30.000Z") });
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: providerOver(table) },
    });
    const composed = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding] });
    await coordinator.prepare({
      publicationId: PUBLICATION,
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    });
    const completed = await coordinator.resume();
    expect(completed.phase).toBe("completed");
    expect(completed.projects[0]?.fence).toMatchObject({ fencingToken: "2", evidenceSha256: EVIDENCE, machineId: MACHINE });
    expect(table.row).toMatchObject({ token: 2, evidenceSha256: EVIDENCE });
    expect(table.row?.releasedAtMs).not.toBeNull();
    expect(read(home, "config.json").storage.backend).toBe("postgresql");
  });

  it("fails closed when an unreleased generation with different evidence holds the lease", async () => {
    const home = makeHome();
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE, publicationId: OTHER_PUBLICATION, evidenceSha256: OTHER_EVIDENCE });
    const before = { ...table.row! };
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: providerOver(table) },
    });
    const composed = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding] });
    await coordinator.prepare({
      publicationId: PUBLICATION,
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    });
    await expect(coordinator.resume()).rejects.toMatchObject({ reason: "publication-conflict" });
    expect(table.row).toEqual(before);
    expect(read(home, "config.json").storage.backend).toBe("sqlite");
  });

  it("fails closed and leaves the files untouched when another generation holds the lease", async () => {
    const home = makeHome();
    const table = new FenceTable();
    table.seed({ machineId: OTHER_MACHINE, publicationId: OTHER_PUBLICATION });
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: providerOver(table) },
    });
    const composed = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding] });
    await coordinator.prepare({
      publicationId: PUBLICATION,
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    });
    await expect(coordinator.resume()).rejects.toThrow();
    expect(read(home, "config.json").storage.backend).toBe("sqlite");
    expect(read(home, "map.json")[HASH_A].remoteProjectId).toBeUndefined();
    expect(table.row).toMatchObject({ publicationId: OTHER_PUBLICATION, releasedAtMs: null });
    expect(existsSync(join(home, ".lcm", "config.json"))).toBe(true);
  });

  it("finishes the release tail when a later publication rebound the released row (Bug #1651)", async () => {
    const home = makeHome();
    const table = new FenceTable();
    const crashing = createBackendPublicationCoordinator({
      homeDir: home,
      observer: (event) => { if (event === "after-release") throw new Error("crash:after-release"); },
      remoteGuard: { mode: "delegated", provider: providerOver(table) },
    });
    const composed = composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding] });
    await crashing.prepare({
      publicationId: PUBLICATION,
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    });
    await expect(crashing.resume()).rejects.toThrow("crash:after-release");
    expect(table.row?.releasedAtMs).not.toBeNull();

    // Another home's publication acquires the released row before the local released checkpoint.
    const guard = new PostgreSqlBackendPublicationGuard(table.executor());
    const successor = await guard.acquire({
      projectId: PROJECT,
      machineId: OTHER_MACHINE,
      publicationId: OTHER_PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: OTHER_EVIDENCE,
      ttlMs: TTL_MS,
    });
    expect(successor.fencingToken).toBe(2n);
    const writes = table.writes;

    const recovering = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: providerOver(table) },
    });
    const completed = await recovering.recoverPending();
    expect(completed?.phase).toBe("completed");
    expect(table.writes).toBe(writes);
    expect(table.row).toMatchObject({ machineId: OTHER_MACHINE, publicationId: OTHER_PUBLICATION, token: 2, releasedAtMs: null });
    expect(completed?.projects[0]?.fence?.fencingToken).toBe("1");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  PostgreSqlBackendPublicationGuardError,
} from "../../src/storage/postgresql/publication-guard.js";
import type {
  PostgreSqlBackendPublicationAcquireInput,
  PostgreSqlBackendPublicationFence,
  PostgreSqlBackendPublicationMutationInput,
} from "../../src/storage/postgresql/publication-guard.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import {
  acquireActivationLease,
  assertActivationLeaseFence,
  classifyPostgreSqlFenceReadFailure,
  readActivationLeaseFence,
  resolveActivationLeaseFence,
  releaseActivationLease,
  renewActivationLease,
  takeoverActivationLease,
  type ActivationLeasePublicationGuard,
} from "../../src/migration/activation-lease.js";

const PROJECT_ID = "project-a";
const MACHINE_ID = "machine-a";
const PUBLICATION_ID = "publication-a";
const EVIDENCE = "e".repeat(64);
const TARGET = "postgresql" as const;

function baseFence(overrides: Partial<PostgreSqlBackendPublicationFence> = {}): PostgreSqlBackendPublicationFence {
  return {
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    publicationId: PUBLICATION_ID,
    targetBackend: TARGET,
    evidenceSha256: EVIDENCE,
    fencingToken: 1n,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    renewedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    releasedAt: null,
    databaseExpired: false,
    ...overrides,
  };
}

function guardError(
  reason: PostgreSqlBackendPublicationGuardError["reason"],
): PostgreSqlBackendPublicationGuardError {
  return new PostgreSqlBackendPublicationGuardError(PROJECT_ID, "op", reason);
}

function pgError(sqlState: string | null, retryable: boolean): PostgreSqlStorageOperationError {
  return new PostgreSqlStorageOperationError(
    "STORAGE_OPERATION_FAILED",
    { domain: "coordination", operation: "readBackendPublication", projectId: PROJECT_ID },
    sqlState,
    retryable,
  );
}

function fakeGuard(overrides: Partial<ActivationLeasePublicationGuard> = {}): ActivationLeasePublicationGuard {
  const unexpected = (name: string) => vi.fn(async () => { throw new Error(`unexpected call to ${name}`); });
  return {
    acquire: overrides.acquire ?? unexpected("acquire"),
    renew: overrides.renew ?? unexpected("renew"),
    release: overrides.release ?? unexpected("release"),
    read: overrides.read ?? unexpected("read"),
  };
}

const acquireInput: PostgreSqlBackendPublicationAcquireInput = {
  projectId: PROJECT_ID,
  machineId: MACHINE_ID,
  publicationId: PUBLICATION_ID,
  targetBackend: TARGET,
  evidenceSha256: EVIDENCE,
  ttlMs: 60_000,
};

const mutationInput: PostgreSqlBackendPublicationMutationInput = {
  projectId: PROJECT_ID,
  machineId: MACHINE_ID,
  publicationId: PUBLICATION_ID,
  targetBackend: TARGET,
  evidenceSha256: EVIDENCE,
  fencingToken: 1n,
};

describe("classifyPostgreSqlFenceReadFailure", () => {
  it("leaves a non-PostgreSqlStorageOperationError unrecognized", () => {
    expect(classifyPostgreSqlFenceReadFailure(new Error("plain"))).toBeUndefined();
  });

  it("leaves a guard-level invalid-row error unrecognized", () => {
    expect(classifyPostgreSqlFenceReadFailure(guardError("invalid-row"))).toBeUndefined();
  });

  it("attributes sqlstate 42501 as unresolvable insufficient-privilege", () => {
    expect(classifyPostgreSqlFenceReadFailure(pgError("42501", false))).toMatchObject({
      kind: "unresolvable",
      cause: "insufficient-privilege",
    });
  });

  it("attributes a retryable failure as unresolvable connection-failure", () => {
    expect(classifyPostgreSqlFenceReadFailure(pgError("08006", true))).toMatchObject({
      kind: "unresolvable",
      cause: "connection-failure",
    });
  });

  it("attributes sqlstate 57014 as unresolvable statement-timeout", () => {
    expect(classifyPostgreSqlFenceReadFailure(pgError("57014", false))).toMatchObject({
      kind: "unresolvable",
      cause: "statement-timeout",
    });
  });

  it("leaves an unrecognized, non-retryable sqlstate unrecognized", () => {
    expect(classifyPostgreSqlFenceReadFailure(pgError("42601", false))).toBeUndefined();
  });
});

describe("readActivationLeaseFence", () => {
  it("reports present for an existing fence", async () => {
    const fence = baseFence();
    const guard = fakeGuard({ read: vi.fn(async () => fence) });
    await expect(readActivationLeaseFence(guard, mutationInput)).resolves.toEqual({ kind: "present", value: fence });
  });

  it("reports absent for a genuinely missing row", async () => {
    const guard = fakeGuard({ read: vi.fn(async () => null) });
    const outcome = await readActivationLeaseFence(guard, mutationInput);
    expect(outcome).toMatchObject({ kind: "absent", cause: "not-found" });
  });

  it("reports unresolvable for a recognized postgresql failure", async () => {
    const guard = fakeGuard({ read: vi.fn(async () => { throw pgError("42501", false); }) });
    const outcome = await readActivationLeaseFence(guard, mutationInput);
    expect(outcome).toMatchObject({ kind: "unresolvable", cause: "insufficient-privilege" });
  });

  it("propagates an unrecognized read failure unchanged", async () => {
    const boom = guardError("invalid-row");
    const guard = fakeGuard({ read: vi.fn(async () => { throw boom; }) });
    await expect(readActivationLeaseFence(guard, mutationInput)).rejects.toThrow(boom);
  });
});

describe("resolveActivationLeaseFence", () => {
  it("reports present for an existing, matching fence", async () => {
    const fence = baseFence();
    const guard = fakeGuard({ read: vi.fn(async () => fence) });
    await expect(resolveActivationLeaseFence(guard, mutationInput)).resolves.toEqual({ kind: "present", fence });
  });

  it("reports absent for a genuinely missing row", async () => {
    const guard = fakeGuard({ read: vi.fn(async () => null) });
    const result = await resolveActivationLeaseFence(guard, mutationInput);
    expect(result.kind).toBe("absent");
  });

  it("reports unresolvable for a recognized postgresql failure", async () => {
    const guard = fakeGuard({ read: vi.fn(async () => { throw pgError("42501", false); }) });
    const result = await resolveActivationLeaseFence(guard, mutationInput);
    expect(result.kind).toBe("unresolvable");
  });

  it(
    "reports identity-mismatch when guard.read() itself refuses a targetBackend/evidenceSha256 mismatch "
      + "(invalid-row), rather than letting the exception propagate",
    async () => {
      const guard = fakeGuard({ read: vi.fn(async () => { throw guardError("invalid-row"); }) });
      const result = await resolveActivationLeaseFence(guard, mutationInput);
      expect(result.kind).toBe("identity-mismatch");
    },
  );

  it("propagates a guard error reason other than invalid-row unchanged", async () => {
    const boom = guardError("readback-mismatch");
    const guard = fakeGuard({ read: vi.fn(async () => { throw boom; }) });
    await expect(resolveActivationLeaseFence(guard, mutationInput)).rejects.toThrow(boom);
  });

  it("propagates a non-guard error unchanged", async () => {
    const boom = new Error("boom");
    const guard = fakeGuard({ read: vi.fn(async () => { throw boom; }) });
    await expect(resolveActivationLeaseFence(guard, mutationInput)).rejects.toThrow(boom);
  });
});

describe("acquireActivationLease", () => {
  it("reports acquired on success", async () => {
    const fence = baseFence();
    const guard = fakeGuard({ acquire: vi.fn(async () => fence) });
    await expect(acquireActivationLease(guard, acquireInput)).resolves.toEqual({ status: "acquired", fence });
  });

  it("reports conflict on publication-conflict", async () => {
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw guardError("publication-conflict"); }) });
    const result = await acquireActivationLease(guard, acquireInput);
    expect(result.status).toBe("conflict");
  });

  it("reports expired-needs-takeover on fence-expired", async () => {
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw guardError("fence-expired"); }) });
    const result = await acquireActivationLease(guard, acquireInput);
    expect(result.status).toBe("expired-needs-takeover");
  });

  it("reports unresolvable on readback-mismatch", async () => {
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw guardError("readback-mismatch"); }) });
    const result = await acquireActivationLease(guard, acquireInput);
    expect(result.status).toBe("unresolvable");
  });

  it("rethrows an unrecognized guard error reason unchanged", async () => {
    const boom = guardError("invalid-row");
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw boom; }) });
    await expect(acquireActivationLease(guard, acquireInput)).rejects.toThrow(boom);
  });

  it("rethrows a non-guard error unchanged", async () => {
    const boom = new Error("boom");
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw boom; }) });
    await expect(acquireActivationLease(guard, acquireInput)).rejects.toThrow(boom);
  });
});

describe("renewActivationLease", () => {
  const renewInput = { ...mutationInput, ttlMs: 60_000 };

  it("reports renewed on success", async () => {
    const fence = baseFence();
    const guard = fakeGuard({ renew: vi.fn(async () => fence) });
    await expect(renewActivationLease(guard, renewInput)).resolves.toEqual({ status: "renewed", fence });
  });

  it("reports not-found when the row is genuinely absent", async () => {
    const guard = fakeGuard({
      renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => null),
    });
    const result = await renewActivationLease(guard, renewInput);
    expect(result.status).toBe("not-found");
  });

  it("reports unresolvable when the diagnostic read itself cannot be completed", async () => {
    const guard = fakeGuard({
      renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => { throw pgError("42501", false); }),
    });
    const result = await renewActivationLease(guard, renewInput);
    expect(result.status).toBe("unresolvable");
  });

  it("reports conflict when a different generation holds the row", async () => {
    const guard = fakeGuard({
      renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => baseFence({ machineId: "someone-else" })),
    });
    const result = await renewActivationLease(guard, renewInput);
    expect(result.status).toBe("conflict");
  });

  it(
    "reports conflict when the diagnostic read finds a targetBackend/evidenceSha256 identity mismatch "
      + "(guard.read() itself refuses that row; see resolveActivationLeaseFence)",
    async () => {
      const guard = fakeGuard({
        renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
        read: vi.fn(async () => { throw guardError("invalid-row"); }),
      });
      const result = await renewActivationLease(guard, renewInput);
      expect(result.status).toBe("conflict");
    },
  );

  it("reports released when the same generation's row was already released", async () => {
    const guard = fakeGuard({
      renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => baseFence({ releasedAt: "2026-01-01T00:30:00.000Z" })),
    });
    const result = await renewActivationLease(guard, renewInput);
    expect(result.status).toBe("released");
  });

  it("reports expired, with the fresh fence, when the same generation's row expired unreleased", async () => {
    const fence = baseFence({ databaseExpired: true });
    const guard = fakeGuard({
      renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => fence),
    });
    const result = await renewActivationLease(guard, renewInput);
    expect(result).toMatchObject({ status: "expired", fence });
  });

  it("reports stale-token, with the fresh fence, when the row moved to a newer token", async () => {
    const fence = baseFence({ fencingToken: 2n });
    const guard = fakeGuard({
      renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => fence),
    });
    const result = await renewActivationLease(guard, renewInput);
    expect(result).toMatchObject({ status: "stale-token", fence });
  });

  it("reports unresolvable when the readback shows an identical, active, matching fence", async () => {
    const fence = baseFence();
    const guard = fakeGuard({
      renew: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => fence),
    });
    const result = await renewActivationLease(guard, renewInput);
    expect(result.status).toBe("unresolvable");
  });

  it("rethrows an unrecognized guard error reason unchanged", async () => {
    const boom = guardError("invalid-row");
    const guard = fakeGuard({ renew: vi.fn(async () => { throw boom; }) });
    await expect(renewActivationLease(guard, renewInput)).rejects.toThrow(boom);
  });

  it("rethrows a non-guard error unchanged", async () => {
    const boom = new Error("boom");
    const guard = fakeGuard({ renew: vi.fn(async () => { throw boom; }) });
    await expect(renewActivationLease(guard, renewInput)).rejects.toThrow(boom);
  });
});

describe("takeoverActivationLease", () => {
  const takeoverInput = { ...acquireInput, expectedFencingToken: 1n };

  it("reports took-over on success", async () => {
    const fence = baseFence({ fencingToken: 2n });
    const guard = fakeGuard({ acquire: vi.fn(async () => fence) });
    await expect(takeoverActivationLease(guard, takeoverInput)).resolves.toEqual({ status: "took-over", fence });
  });

  it("reports conflict on publication-conflict", async () => {
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw guardError("publication-conflict"); }) });
    const result = await takeoverActivationLease(guard, takeoverInput);
    expect(result.status).toBe("conflict");
  });

  it("reports token-mismatch on fence-mismatch", async () => {
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw guardError("fence-mismatch"); }) });
    const result = await takeoverActivationLease(guard, takeoverInput);
    expect(result.status).toBe("token-mismatch");
  });

  it("reports unresolvable on readback-mismatch", async () => {
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw guardError("readback-mismatch"); }) });
    const result = await takeoverActivationLease(guard, takeoverInput);
    expect(result.status).toBe("unresolvable");
  });

  it("rethrows an unrecognized guard error reason unchanged", async () => {
    const boom = guardError("invalid-row");
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw boom; }) });
    await expect(takeoverActivationLease(guard, takeoverInput)).rejects.toThrow(boom);
  });

  it("rethrows a non-guard error unchanged", async () => {
    const boom = new Error("boom");
    const guard = fakeGuard({ acquire: vi.fn(async () => { throw boom; }) });
    await expect(takeoverActivationLease(guard, takeoverInput)).rejects.toThrow(boom);
  });
});

describe("releaseActivationLease", () => {
  it("reports released on success", async () => {
    const fence = baseFence({ releasedAt: "2026-01-01T00:30:00.000Z" });
    const guard = fakeGuard({ release: vi.fn(async () => fence) });
    await expect(releaseActivationLease(guard, mutationInput)).resolves.toEqual({ status: "released", fence });
  });

  it("reports not-found when the row is genuinely absent", async () => {
    const guard = fakeGuard({
      release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => null),
    });
    const result = await releaseActivationLease(guard, mutationInput);
    expect(result.status).toBe("not-found");
  });

  it("reports unresolvable when the diagnostic read itself cannot be completed", async () => {
    const guard = fakeGuard({
      release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => { throw pgError("42501", false); }),
    });
    const result = await releaseActivationLease(guard, mutationInput);
    expect(result.status).toBe("unresolvable");
  });

  it("reports conflict when a different generation holds the row", async () => {
    const guard = fakeGuard({
      release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => baseFence({ machineId: "someone-else" })),
    });
    const result = await releaseActivationLease(guard, mutationInput);
    expect(result.status).toBe("conflict");
  });

  it(
    "reports conflict when the diagnostic read finds a targetBackend/evidenceSha256 identity mismatch "
      + "(guard.read() itself refuses that row; see resolveActivationLeaseFence)",
    async () => {
      const guard = fakeGuard({
        release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
        read: vi.fn(async () => { throw guardError("invalid-row"); }),
      });
      const result = await releaseActivationLease(guard, mutationInput);
      expect(result.status).toBe("conflict");
    },
  );

  it("reports already-released idempotently when the same token already released it", async () => {
    const fence = baseFence({ releasedAt: "2026-01-01T00:30:00.000Z", fencingToken: 1n });
    const guard = fakeGuard({
      release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => fence),
    });
    const result = await releaseActivationLease(guard, mutationInput);
    expect(result).toEqual({ status: "already-released", fence });
  });

  it("reports conflict when released under a different token than the caller's", async () => {
    const fence = baseFence({ releasedAt: "2026-01-01T00:30:00.000Z", fencingToken: 2n });
    const guard = fakeGuard({
      release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => fence),
    });
    const result = await releaseActivationLease(guard, mutationInput);
    expect(result.status).toBe("conflict");
  });

  it("reports expired, with the fresh fence, when the row expired unreleased", async () => {
    const fence = baseFence({ databaseExpired: true });
    const guard = fakeGuard({
      release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => fence),
    });
    const result = await releaseActivationLease(guard, mutationInput);
    expect(result).toMatchObject({ status: "expired", fence });
  });

  it("reports stale-token, with the fresh fence, when the row moved to a newer token", async () => {
    const fence = baseFence({ fencingToken: 2n });
    const guard = fakeGuard({
      release: vi.fn(async () => { throw guardError("fence-mismatch"); }),
      read: vi.fn(async () => fence),
    });
    const result = await releaseActivationLease(guard, mutationInput);
    expect(result).toMatchObject({ status: "stale-token", fence });
  });

  it("rethrows an unrecognized guard error reason unchanged", async () => {
    const boom = guardError("invalid-row");
    const guard = fakeGuard({ release: vi.fn(async () => { throw boom; }) });
    await expect(releaseActivationLease(guard, mutationInput)).rejects.toThrow(boom);
  });

  it("rethrows a non-guard error unchanged", async () => {
    const boom = new Error("boom");
    const guard = fakeGuard({ release: vi.fn(async () => { throw boom; }) });
    await expect(releaseActivationLease(guard, mutationInput)).rejects.toThrow(boom);
  });
});

describe("assertActivationLeaseFence", () => {
  const assertInput = {
    projectId: PROJECT_ID,
    publicationId: PUBLICATION_ID,
    targetBackend: TARGET,
    evidenceSha256: EVIDENCE,
  };

  it("reports satisfied for an active, matching fence", async () => {
    const fence = baseFence();
    const guard = fakeGuard({ read: vi.fn(async () => fence) });
    const result = await assertActivationLeaseFence(guard, assertInput);
    expect(result).toEqual({
      status: "satisfied",
      reason: "fence-active-and-matching",
      detail: expect.any(String),
      fence,
    });
  });

  it("reports unresolvable/fence-read-unresolvable when the read cannot be completed", async () => {
    const guard = fakeGuard({ read: vi.fn(async () => { throw pgError("42501", false); }) });
    const result = await assertActivationLeaseFence(guard, assertInput);
    expect(result).toMatchObject({ status: "unresolvable", reason: "fence-read-unresolvable", fence: null });
  });

  it("reports unsatisfied/fence-absent when no row exists", async () => {
    const guard = fakeGuard({ read: vi.fn(async () => null) });
    const result = await assertActivationLeaseFence(guard, assertInput);
    expect(result).toMatchObject({ status: "unsatisfied", reason: "fence-absent", fence: null });
  });

  it("reports unsatisfied/fence-identity-mismatch on a differing publicationId", async () => {
    const fence = baseFence({ publicationId: "different-publication" });
    const guard = fakeGuard({ read: vi.fn(async () => fence) });
    const result = await assertActivationLeaseFence(guard, assertInput);
    expect(result).toMatchObject({ status: "unsatisfied", reason: "fence-identity-mismatch", fence });
  });

  it(
    "reports unsatisfied/fence-identity-mismatch with fence: null on a targetBackend/evidenceSha256 "
      + "mismatch (guard.read() itself refuses to return the differing row; see resolveActivationLeaseFence)",
    async () => {
      const guard = fakeGuard({ read: vi.fn(async () => { throw guardError("invalid-row"); }) });
      const result = await assertActivationLeaseFence(guard, assertInput);
      expect(result).toMatchObject({ status: "unsatisfied", reason: "fence-identity-mismatch", fence: null });
    },
  );

  it("propagates a guard error reason other than invalid-row unchanged, never guessing at attribution", async () => {
    const boom = guardError("readback-mismatch");
    // readActivationLeaseFence's own classifier does not recognize this
    // reason, so it is not "unresolvable" either; resolveActivationLeaseFence
    // only converts "invalid-row" -- anything else propagates.
    const guard = fakeGuard({ read: vi.fn(async () => { throw boom; }) });
    await expect(assertActivationLeaseFence(guard, assertInput)).rejects.toThrow(boom);
  });

  it("does not compare machineId (a differing machineId still passes identity)", async () => {
    const fence = baseFence({ machineId: "irrelevant-machine" });
    const guard = fakeGuard({ read: vi.fn(async () => fence) });
    const result = await assertActivationLeaseFence(guard, assertInput);
    expect(result.status).toBe("satisfied");
  });

  it("reports unsatisfied/fence-released for a released fence", async () => {
    const fence = baseFence({ releasedAt: "2026-01-01T00:30:00.000Z" });
    const guard = fakeGuard({ read: vi.fn(async () => fence) });
    const result = await assertActivationLeaseFence(guard, assertInput);
    expect(result).toMatchObject({ status: "unsatisfied", reason: "fence-released", fence });
  });

  it("reports unsatisfied/fence-expired for an expired, unreleased fence", async () => {
    const fence = baseFence({ databaseExpired: true });
    const guard = fakeGuard({ read: vi.fn(async () => fence) });
    const result = await assertActivationLeaseFence(guard, assertInput);
    expect(result).toMatchObject({ status: "unsatisfied", reason: "fence-expired", fence });
  });
});

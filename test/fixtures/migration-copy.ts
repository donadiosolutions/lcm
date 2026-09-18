import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import {
  prepareSqliteMigrationEnrollment,
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import * as identityApi from "../../src/machine-identity.js";
import { type IdentityRepository } from "../../src/identity-service.js";
import { clearProjectMapCache } from "../../src/project-map.js";
import { closeLcmConnection } from "../../src/db/connection.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const roots: string[] = [];

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-maintenance-v3-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function coordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => {
    throw new Error("v2 driver must not run for maintenance");
  };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

function input() {
  return {
    publicationId: "migration-generation-1",
    generationId: "generation-1",
    sourceSelectionSha256: HASH_A,
    queueEvidenceSha256: HASH_B,
    roster: [{
      machineId: MACHINE_ID,
      queueCutoff: "0000000000000000012",
      evidenceSha256: HASH_A,
    }],
    now: new Date("2026-09-07T03:04:05.000Z"),
  } as const;
}

export const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

export function enrollmentFixture() {
  const homeDir = home();
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  const metadata = join(projectDir, "meta.json");
  writeFileSync(metadata, `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  const request: SqliteMigrationEnrollmentInput = {
    cwd, homeDir, targetConfig: { backend: "postgresql", postgresql: {
      url: "postgresql://unused.invalid/lcm", caFile: "/unused", migrationRole: "unused",
      poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
    } },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: REGISTERED_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = {
    registerMachine: vi.fn(async () => registered()),
    recoverMachine: vi.fn(async () => registered()),
  };
  const close = vi.fn(async () => undefined);
  const openIdentitySession = vi.fn(async () => ({ repository: repository as unknown as IdentityRepository, close }));
  return { homeDir, cwd, local, projectDir, metadata, request, registered, repository, close, openIdentitySession };
}

export async function populatedFixture(legacy = false) {
  const fixture = enrollmentFixture();
  const factory = new SQLiteLocalHookOutboxFactory();
  const outbox = await factory.open(join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`));
  if (legacy) await outbox.insertEvent("legacy", { type: "decision", category: "decision", data: "unknown legacy effect", priority: 1 }, "SessionStart");
  await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
  if (!legacy) await outbox.insertEvent("pending", { type: "decision", category: "decision", data: "proven receipt-era pending", priority: 1 }, "SessionStart");
  await factory.close();
  return fixture;
}

export async function heldSource(fixture: ReturnType<typeof enrollmentFixture>) {
  return withBackendPublicationAppendBarrierAsync(fixture.homeDir, async (token) => {
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir, token);
    const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: fixture.homeDir, lockToken: token });
    const held = await coordinator(fixture.homeDir).enterMaintenance({
      ...input(), sourceSelectionSha256: authority.sourceSelectionSha256,
      queueEvidenceSha256: expectedSourceBytes.checksumSha256,
      roster: [{ machineId: REGISTERED_MACHINE, queueCutoff: "0000000000000000000", evidenceSha256: expectedSourceBytes.checksumSha256 }],
    }, token);
    return { authority, options: { homeDir: fixture.homeDir, generationId: held.generationId,
      maintenanceChecksumSha256: held.checksumSha256, expectedSourceBytes } };
  });
}

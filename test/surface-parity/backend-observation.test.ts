import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { daemonConfigSnapshotWitnessEqual, readDaemonConfigSnapshot } from "../../src/daemon/config.js";
import {
  assertBackendPublicationConfigReadAccess,
  BackendPublicationJournalError,
  withBackendPublicationConsumerLock,
  withBackendPublicationReadRoot,
} from "../../src/storage/backend-publication.js";
import { assertSelectedBackend } from "./backend-observation.mjs";

function fixture(backend: "sqlite" | "postgresql" = "sqlite") {
  const homeDir = mkdtempSync(join(tmpdir(), "surface-backend-observer-"));
  const lcmDir = join(homeDir, ".lcm");
  mkdirSync(lcmDir, { mode: 0o700 });
  const configPath = join(lcmDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ storage: { backend } }), { mode: 0o600 });
  const caPath = join(homeDir, "ca.pem");
  writeFileSync(caPath, "fixture CA bytes", { mode: 0o600 });
  const options = { homeDir, configPath, backend, assertNoSqliteFiles: () => {} };
  const operations = {
    withReadRoot: withBackendPublicationReadRoot,
    readSnapshot: (path: string) => readDaemonConfigSnapshot(path, {
      LCM_POSTGRES_URL: "postgresql://fixture:fixture@localhost/fixture",
      LCM_POSTGRES_CA_FILE: caPath,
      LCM_POSTGRES_MIGRATION_ROLE: "fixture_migrator",
    }),
    assertReadAccess: assertBackendPublicationConfigReadAccess,
    witnessEqual: daemonConfigSnapshotWitnessEqual,
  };
  return { options, operations, cleanup: () => rmSync(homeDir, { recursive: true, force: true }) };
}

it("observes the configured backend while a publication mutation lock is held", () => {
  const f = fixture();
  try {
    withBackendPublicationConsumerLock(f.options.homeDir, () => {
      expect(() => assertSelectedBackend(f.options, f.operations)).not.toThrow();
    });
  } finally { f.cleanup(); }
});

it("rejects a same-content config inode replacement without retrying", () => {
  const f = fixture();
  let reads = 0;
  try {
    const readSnapshot = (path: string) => {
      if (++reads === 2) {
        const replacement = `${path}.replacement`;
        writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
        renameSync(replacement, path);
      }
      return f.operations.readSnapshot(path);
    };
    expect(() => assertSelectedBackend(f.options, { ...f.operations, readSnapshot }))
      .toThrow("surface-observer:config-changed");
    expect(reads).toBe(2);
  } finally { f.cleanup(); }
});

it("rejects missing config instead of accepting SQLite defaults", () => {
  const f = fixture();
  try {
    rmSync(f.options.configPath);
    expect(() => assertSelectedBackend(f.options, f.operations)).toThrow("surface-observer:config-absent");
  } finally { f.cleanup(); }
});

it("rejects PostgreSQL selection without publication admission evidence", () => {
  const f = fixture("postgresql");
  try {
    expect(() => assertSelectedBackend(f.options, f.operations)).toThrow(BackendPublicationJournalError);
    expect(() => assertSelectedBackend(f.options, f.operations)).toThrow("PostgreSQL selection has no completed backend publication evidence");
  } finally { f.cleanup(); }
});

it("rejects differing journal admissions even when both config witnesses match", () => {
  const f = fixture();
  let admissions = 0;
  try {
    const assertReadAccess: typeof assertBackendPublicationConfigReadAccess = (...args) => {
      const admission = f.operations.assertReadAccess(...args);
      return ++admissions === 2 ? { journalChecksumSha256: "0".repeat(64) } : admission;
    };
    expect(() => assertSelectedBackend(f.options, { ...f.operations, assertReadAccess }))
      .toThrow("surface-observer:publication-changed");
    expect(admissions).toBe(2);
  } finally { f.cleanup(); }
});

it("rejects a selected backend different from the fixture", () => {
  const f = fixture();
  try {
    expect(() => assertSelectedBackend({ ...f.options, backend: "postgresql" }, f.operations))
      .toThrow("surface-observer:selection-changed");
  } finally { f.cleanup(); }
});

it("rejects replacement of the admitted root without retrying", () => {
  const f = fixture();
  let reads = 0;
  try {
    const readSnapshot = (path: string) => {
      reads++;
      const snapshot = f.operations.readSnapshot(path);
      const lcmDir = join(f.options.homeDir, ".lcm");
      const original = readFileSync(path);
      renameSync(lcmDir, `${lcmDir}.old`);
      mkdirSync(lcmDir, { mode: 0o700 });
      writeFileSync(path, original, { mode: 0o600 });
      return snapshot;
    };
    expect(() => assertSelectedBackend(f.options, { ...f.operations, readSnapshot }))
      .toThrow(BackendPublicationJournalError);
    expect(reads).toBe(1);
  } finally { f.cleanup(); }
});

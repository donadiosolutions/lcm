import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as security from "../../src/security-files.js";
import * as connections from "../../src/db/connection.js";
import { readCurrentLocalHookOutboxIdentity } from "../../src/storage/local-hook-outbox-schema.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { withBackendPublicationAppendBarrierAsync, withBackendPublicationConsumerLockAsync } from "../../src/storage/backend-publication.js";
import { EventsDb } from "../../src/hooks/events-db.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  connections.closeLcmConnection();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(wal = false, version = 5) {
  const root = fs.mkdtempSync(join(tmpdir(), "lcm-outbox-schema-test-"));
  roots.push(root);
  const path = join(root, "events.db");
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  db.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(${version})`);
  if (!wal) db.close();
  fs.chmodSync(path, 0o600);
  if (wal) { fs.chmodSync(`${path}-wal`, 0o600); fs.chmodSync(`${path}-shm`, 0o600); }
  return { root, path, db };
}
function evidence(path: string) {
  return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].map(p => fs.existsSync(p)
    ? { path: p, bytes: fs.readFileSync(p), mode: fs.statSync(p).mode } : { path: p, absent: true });
}

describe("local outbox schema admission", () => {
  it("keeps the EventsDb current-schema guard when opening directly", () => {
    const value = fixture(false, 1);
    expect(() => EventsDb.openExisting(value.path, { _requireCurrentSchema: true })).toThrow("not current");
    expect(connections.isLcmConnectionOpen(value.path)).toBe(false);
    const database = new DatabaseSync(value.path, { readOnly: true });
    try { expect(database.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 1 }); }
    finally { database.close(); }
  });
  it.each([false, true])("reads current schema with WAL=%s without source mutation", wal => {
    const value = fixture(wal);
    const before = evidence(value.path);
    try {
      expect(readCurrentLocalHookOutboxIdentity(value.path, 5)).toEqual({
        device: fs.statSync(value.path).dev, inode: fs.statSync(value.path).ino,
      });
      expect(evidence(value.path)).toEqual(before);
    } finally { if (wal) value.db.close(); }
  });
  it.each([false, true])("refuses legacy schema with WAL=%s without source mutation", wal => {
    const value = fixture(wal, 1);
    const before = evidence(value.path);
    try {
      expect(() => readCurrentLocalHookOutboxIdentity(value.path, 5)).toThrow("not current");
      expect(evidence(value.path)).toEqual(before);
    } finally { if (wal) value.db.close(); }
  });
  it("does not initialize a missing parent or file", () => {
    const value = fixture();
    expect(readCurrentLocalHookOutboxIdentity(join(value.root, "absent", "db"), 5)).toBeNull();
    expect(readCurrentLocalHookOutboxIdentity(join(value.root, "absent.db"), 5)).toBeNull();
    expect(fs.readdirSync(value.root)).toEqual(["events.db"]);
  });
  it.each(["symlink", "directory", "link", "mode", "size", "owner"])("refuses unsafe %s source before copying", kind => {
    const value = fixture();
    if (kind === "symlink") { fs.renameSync(value.path, `${value.path}.original`); fs.symlinkSync(`${value.path}.original`, value.path); }
    if (kind === "directory") { fs.unlinkSync(value.path); fs.mkdirSync(value.path); }
    if (kind === "link") fs.linkSync(value.path, `${value.path}.alias`);
    if (kind === "mode") fs.chmodSync(value.path, 0o644);
    if (kind === "size") fs.truncateSync(value.path, 8 * 1024 ** 3 + 1);
    if (kind === "owner") vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
    expect(() => readCurrentLocalHookOutboxIdentity(value.path, 5)).toThrow();
  });
  it("supports platforms without getuid and read-only source modes", () => {
    const value = fixture();
    fs.chmodSync(value.path, 0o400);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", { ...descriptor, value: undefined });
    try { expect(readCurrentLocalHookOutboxIdentity(value.path, 5)).toMatchObject({ inode: fs.statSync(value.path).ino }); }
    finally { Object.defineProperty(process, "getuid", descriptor); }
  });
  it("refuses a rollback journal without touching it", () => {
    const value = fixture();
    fs.writeFileSync(`${value.path}-journal`, "journal", { mode: 0o600 });
    const before = evidence(value.path);
    expect(() => readCurrentLocalHookOutboxIdentity(value.path, 5)).toThrow("rollback journal");
    expect(evidence(value.path)).toEqual(before);
  });
  it.each(["collision", "copy-content", "source-content", "membership", "source-replaced"])("refuses %s drift and removes private scratch", kind => {
    const value = fixture();
    const original = security.copyRegularFilePrivateExclusive;
    let scratch = "";
    vi.spyOn(security, "copyRegularFilePrivateExclusive").mockImplementation((source, destination, options) => {
      scratch = destination.slice(0, destination.lastIndexOf("/"));
      if (kind === "collision") return false;
      const result = original(source, destination, options);
      if (kind === "copy-content") fs.appendFileSync(destination, "tampered");
      if (kind === "source-content") fs.appendFileSync(source, "drift");
      if (kind === "membership") fs.writeFileSync(`${source}-shm`, "changed", { mode: 0o600 });
      if (kind === "source-replaced") { fs.renameSync(source, `${source}.old`); fs.copyFileSync(`${source}.old`, source); }
      return result;
    });
    expect(() => readCurrentLocalHookOutboxIdentity(value.path, 5)).toThrow("changed");
    expect(fs.existsSync(scratch)).toBe(false);
  });
  it("refuses a source that changes during its authenticated read", () => {
    const value = fixture();
    const original = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      const result = original(...args);
      fs.appendFileSync(value.path, "changed");
      return result;
    });
    expect(() => readCurrentLocalHookOutboxIdentity(value.path, 5)).toThrow("source changed");
  });
  it("returns no writable-open identity if scratch cleanup fails", () => {
    const value = fixture();
    const original = fs.rmSync;
    let scratch = "";
    vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (String(path).includes("lcm-outbox-schema-")) {
        scratch = String(path);
        throw new Error("scratch cleanup failed");
      }
      return original(path, options);
    });
    try {
      expect(() => readCurrentLocalHookOutboxIdentity(value.path, 5)).toThrow("scratch cleanup failed");
      expect(connections.isLcmConnectionOpen(value.path)).toBe(false);
    } finally { original(scratch, { recursive: true, force: true }); }
  });
  it.each(["removed", "replaced"])("rejects %s preflight identity before writable setup", kind => {
    const value = fixture();
    const mode = fs.statSync(value.path).mode;
    const open = () => {
      const expectedFileIdentity = readCurrentLocalHookOutboxIdentity(value.path, 5)!;
      fs.renameSync(value.path, `${value.path}.old`);
      if (kind === "replaced") { fs.copyFileSync(`${value.path}.old`, value.path); fs.chmodSync(value.path, 0o400); }
      return connections.getExistingLcmConnection(value.path, { expectedFileIdentity });
    };
    if (kind === "removed") expect(open()).toBeNull();
    else expect(open).toThrow("changed after read-only preflight");
    expect(fs.statSync(`${value.path}.old`).mode).toBe(mode);
    if (kind === "replaced") expect(fs.statSync(value.path).mode & 0o777).toBe(0o400);
    expect(fs.existsSync(`${value.path}-wal`)).toBe(false);
  });
  it.each(["append", "consumer"] as const)("opens repeatedly with an explicit %s token without deadlock", async kind => {
    const value = fixture();
    const home = join(value.root, "home");
    const events = join(home, ".lcm", "events");
    fs.mkdirSync(events, { recursive: true, mode: 0o700 });
    const path = join(events, "current.db");
    const factory = new SQLiteLocalHookOutboxFactory();
    const operation = async (token: Parameters<Parameters<typeof withBackendPublicationAppendBarrierAsync>[1]>[0]) => {
      await (await factory.open(path, {}, token)).close(token);
      await (await factory.openExisting(path, {}, token))!.close(token);
    };
    try {
      if (kind === "append") await withBackendPublicationAppendBarrierAsync(home, operation);
      else await withBackendPublicationConsumerLockAsync(home, operation);
    } finally { await factory.close(); }
  });
  it.each(["open", "openExisting"] as const)("does not register a queued %s after its factory closes", async operation => {
    const value = fixture();
    const home = join(value.root, "home");
    const events = join(home, ".lcm", "events");
    fs.mkdirSync(events, { recursive: true, mode: 0o700 });
    const path = join(events, "current.db");
    const factory = new SQLiteLocalHookOutboxFactory();
    let enterHolder!: () => void;
    let releaseHolder!: () => void;
    const entered = new Promise<void>(resolve => { enterHolder = resolve; });
    const release = new Promise<void>(resolve => { releaseHolder = resolve; });
    const holder = withBackendPublicationAppendBarrierAsync(home, async () => {
      enterHolder();
      await release;
    });
    await entered;
    const pending = factory[operation](path);
    await factory.close();
    releaseHolder();
    await holder;
    await expect(pending).rejects.toMatchObject({ code: "STORAGE_CLOSED", operation });
    expect(fs.existsSync(path)).toBe(false);
    expect(connections.isLcmConnectionOpen(path)).toBe(false);
  });
});
